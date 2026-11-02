import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {runPaperLayoutAgent} from '../src/paper-layout-agent.mjs';
import {deriveLayoutOutcome} from '../src/paper-layout-outcome.mjs';
const enc=new TextEncoder();
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const list=(items=[])=>({total:items.length,offset:0,limit:20,nextOffset:null,items});
const comparison=(over={})=>({schema:'falsify.layout-document-comparison.v1',baselineProjectId:'base',baselineHash:A,projectId:'cand',outputHash:B,tokens:{method:'extracted-token-multiset',text:{missing:list(),added:list()},numbers:{missing:list(),added:list()}},sourceContent:{unchanged:true,changes:list(),numbers:{missing:list(),added:list()}},assets:{counts:{unchanged:1,changed:0,added:0,missing:0}},links:{missing:list(),added:list()},...over});
const inspection=(issues=[],over={})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:B,issues,coverage:{pages:2},...over});
const overlap={type:'text_overlap',pageIndex:1,bbox:[10,20,30,40],penalty:5,evidence:{blocks:['u1','u2']}};

test('partial inspection with overlap and missing numbers reports issues and changed content',()=>{
 const c=comparison();c.tokens.numbers.missing=list(['63','0.71']);
 const q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection([overlap]),comparison:c,observedPages:[1,0,1,-1]});
 assert.equal(q.content,'changed');assert.equal(q.layout,'issues');assert.deepEqual(q.observedPages,[0,1]);
 const numbers=q.findings.find(f=>f.code==='NUMBERS_MISSING');assert.equal(numbers.severity,'error');assert.deepEqual(numbers.evidence.items,['63','0.71']);
 const layout=q.findings.find(f=>f.code==='text_overlap');assert.equal(layout.pageIndex,1);assert.deepEqual(layout.bbox,[10,20,30,40]);assert.equal(layout.severity,'error');assert.equal(layout.document,'candidate');
});

test('clean evidence or identical PDF bytes establish content preservation; source identity alone does not',()=>{
 let q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection(),comparison:comparison()});
 assert.equal(q.content,'unchanged');assert.equal(q.layout,'clear');assert.deepEqual(q.findings,[]);
 q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'base',baselineProjectId:'base'});assert.equal(q.content,'unverified');assert.equal(q.layout,'unverified');
 q=deriveLayoutOutcome({candidatePdfHash:A,baselinePdfHash:A,candidateProjectId:'base',baselineProjectId:'base'});assert.equal(q.content,'unchanged');
 q=deriveLayoutOutcome({candidatePdfHash:null,candidateProjectId:'base',baselineProjectId:'base'});assert.equal(q.content,'unverified');
});

test('stale, mismatched or incomplete evidence stays unverified rather than failing',()=>{
 const stale=deriveLayoutOutcome({candidatePdfHash:C,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection([overlap]),comparison:comparison()});
 assert.equal(stale.content,'unverified');assert.equal(stale.layout,'unverified');assert.deepEqual(stale.findings,[]);
 const otherBaseline=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:C,baselineProjectId:'base',comparison:comparison()});assert.equal(otherBaseline.content,'unverified');
 const noTokens=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',comparison:comparison({tokens:{method:'unavailable'}})});assert.equal(noTokens.content,'unverified');assert.deepEqual(noTokens.findings,[]);
 const unavailable=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{status:'unavailable'})});assert.equal(unavailable.layout,'unverified');
 const sourceOnly=deriveLayoutOutcome({candidatePdfHash:null,candidateProjectId:'cand',baselineProjectId:'base',inspection:inspection([overlap])});assert.equal(sourceOnly.pdfHash,null);assert.equal(sourceOnly.content,'unverified');assert.equal(sourceOnly.layout,'unverified');
 assert.equal(deriveLayoutOutcome().content,'unverified');assert.equal(deriveLayoutOutcome(null).layout,'unverified');
});

test('source content, link and added-text differences are content changes',()=>{
 for(const [over,code] of [[{sourceContent:{unchanged:false,changes:list(['main.tex']),numbers:{missing:list(),added:list()}}},'SOURCE_CONTENT_CHANGED'],[{links:{missing:list([{uri:'https://x',external:true,targetPage:null}]),added:list()}},'LINKS_MISSING']]){
  const q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',comparison:comparison(over)});assert.equal(q.content,'changed',code);assert.ok(q.findings.some(f=>f.code===code),code);
 }
 const c=comparison();c.tokens.text.added=list(['injected']);assert.equal(deriveLayoutOutcome({candidatePdfHash:B,baselinePdfHash:A,comparison:c}).content,'changed');
});

test('compiler diagnostics for the current PDF become findings without input mutation',()=>{
 const input={candidatePdfHash:B,diagnostics:[{code:'TEX_OVERFULL_BOX',message:'overflow',severity:'warning',count:2}],inspection:inspection([overlap])};const copy=structuredClone(input);
 const q=deriveLayoutOutcome(input);assert.deepEqual(input,copy);assert.ok(q.findings.some(f=>f.code==='TEX_OVERFULL_BOX'&&f.evidence.count===2));
});

const action=(tool,extra={})=>['checkpoint','restore_revision','compare_document'].includes(tool)?{tool,args:extra,message:''}:({tool,path:'',before:'',after:'',pages:[],message:'',...extra});
const artifactFor=p=>{const bytes=enc.encode('%PDF '+p.id);return {success:true,projectId:p.id,engine:p.engine,pdfBytes:bytes,pdfHash:hex(bytes),diagnostics:[]};};

test('workflow finish stays complete while quality exposes overlap and missing numbers',async()=>{
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Evidence 63 and RED 71. \\vspace{2pt} Text.')},{path:'asset.png',bytes:Uint8Array.of(1,2)}]});
 const baseline=artifactFor(project),states=[];
 const actions=[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[1]}),action('compare_document'),action('finish',{message:'done'})];
 const out=await runPaperLayoutAgent({project,artifact:baseline,decide:async()=>actions.shift(),compile:async({project})=>artifactFor(project),
  inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[overlap],coverage:{pages:2}}),
  render:async()=>({images:[{pageIndex:1,mime:'image/png',base64:'iVBORw0KGgo='}],coverage:{pages:[1],complete:false}}),
  handlers:{compare_document:async({project,artifact,baselineProject,baselineArtifact})=>{const c=comparison({baselineProjectId:baselineProject.id,baselineHash:baselineArtifact.pdfHash,projectId:project.id,outputHash:artifact.pdfHash});c.tokens.numbers.missing=list(['63']);return {observation:c};}},
  onState:s=>{states.push(s);throw new Error('observer failure');}});
 assert.equal(out.status,'complete');assert.equal(out.runState,'completed');
 assert.equal(out.quality.content,'changed');assert.equal(out.quality.layout,'issues');assert.deepEqual(out.quality.observedPages,[1]);assert.equal(out.quality.pdfHash,out.artifact.pdfHash);
 assert.ok(out.quality.findings.some(f=>f.code==='NUMBERS_MISSING'));assert.ok(out.quality.findings.some(f=>f.code==='text_overlap'&&f.pageIndex===1));
 assert.equal(out.coverage.render.complete,false);assert.ok(out.artifact.pdfBytes.length>0);
 assert.equal(states[0].runState,'running');assert.equal(states.at(-1).runState,'completed');assert.equal(states.at(-1).status,'complete');assert.equal(states.at(-1),out.sessionState);
 assert.ok(states.length>=6);assert.ok(Object.isFrozen(out.sessionState)&&Object.isFrozen(out.sessionState.candidate.project.files));
 assert.equal(out.sessionState.baselineProject.id,project.id);assert.equal(out.sessionState.baselineArtifact.pdfHash,baseline.pdfHash);assert.equal(out.sessionState.stepCount,6);
 assert.equal(states[1].baselineProject.files[0].bytes,states.at(-1).baselineProject.files[0].bytes,'asset buffers are shared, not cloned per snapshot');
});

// F4: zero findings from a partial or limited inspection is "no detected issue in the
// observed scope", not a verified layout. layout:'clear' stays for compatibility.
test('partial inspection with zero findings is scoped, carries limitations and coverage, and is not verified',()=>{
 const lim=['Scores measure detected defects only; they are not proof of visual quality.','Heading could not be uniquely observed.'];
 const q=deriveLayoutOutcome({candidatePdfHash:B,baselinePdfHash:A,comparison:comparison(),inspection:inspection([],{limitations:lim,coverage:{pages:2,profile:{headings:{checked:1,skipped:1}}}})});
 assert.equal(q.layout,'clear');assert.equal(q.layoutScope,'observed');assert.equal(q.layoutVerified,false);assert.equal(q.inspectionStatus,'partial');
 assert.deepEqual(q.limitations,lim);assert.deepEqual(q.coverage,{pages:2,profile:{headings:{checked:1,skipped:1}}});
 // Partial without any limitation text is still only the observed scope.
 const bare=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection()});assert.equal(bare.layoutScope,'observed');assert.equal(bare.layoutVerified,false);assert.deepEqual(bare.limitations,[]);
 // Only an ok inspection without limitations or truncation is complete.
 const full=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{status:'ok',limitations:[]})});assert.equal(full.layoutScope,'complete');assert.equal(full.layoutVerified,true);
 const okLimited=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{status:'ok',limitations:['Column geometry is invalid or unavailable.']})});assert.equal(okLimited.layoutScope,'observed');assert.equal(okLimited.layoutVerified,false);
});

test('truncated inspection keeps its issues and always carries the truncation limitation',()=>{
 const q=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([overlap],{status:'ok',limitations:[],coverage:{pages:2,findingsTruncated:true}})});
 assert.equal(q.layout,'issues');assert.equal(q.layoutVerified,false);assert.equal(q.layoutScope,'observed');assert.ok(q.limitations.includes('Findings truncated.'));assert.equal(q.coverage.findingsTruncated,true);
 const viaText=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([overlap],{limitations:['Findings truncated.','Findings truncated.']})});assert.deepEqual(viaText.limitations,['Findings truncated.']);
 // Oversized or non-string limitation entries are bounded, never thrown.
 const noisy=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{limitations:[42,null,'x'.repeat(1000),...Array.from({length:40},(_,i)=>'L'+i)],coverage:{blob:'y'.repeat(10000)}})});
 assert.ok(noisy.limitations.length<=25);assert.ok(noisy.limitations.every(s=>typeof s==='string'&&s.length<=300));assert.deepEqual(noisy.coverage,{truncated:true});
});

test('unavailable, mismatched-hash and issue-bearing inspections never pass',()=>{
 const unavailable=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{status:'unavailable',limitations:['MuPDF unavailable.']})});
 assert.equal(unavailable.layout,'unverified');assert.equal(unavailable.layoutScope,null);assert.equal(unavailable.layoutVerified,false);assert.equal(unavailable.inspectionStatus,'unavailable');assert.deepEqual(unavailable.limitations,['MuPDF unavailable.']);
 const stale=deriveLayoutOutcome({candidatePdfHash:C,inspection:inspection([],{status:'ok',limitations:[]})});
 assert.equal(stale.layout,'unverified');assert.equal(stale.layoutVerified,false);assert.equal(stale.inspectionStatus,null);assert.deepEqual(stale.limitations,[]);assert.equal(stale.coverage,null);
 const active=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([overlap],{status:'ok',limitations:[]})});assert.equal(active.layout,'issues');assert.equal(active.layoutScope,'complete');assert.equal(active.layoutVerified,false);
 const none=deriveLayoutOutcome();assert.equal(none.layoutVerified,false);assert.equal(none.layoutScope,null);assert.deepEqual(none.limitations,[]);
});

test('agent quality for a partial zero-finding inspection is scoped and carries the audit limitations',async()=>{
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Body. \\vspace{2pt} Text.')}]});
 const lim=['Scores measure detected defects only; they are not proof of visual quality.','Findings truncated.'];
 const actions=[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{3pt}'}),action('compile_pdf'),action('inspect_pdf'),action('finish',{message:'done'})];
 const out=await runPaperLayoutAgent({project,artifact:artifactFor(project),decide:async()=>actions.shift(),compile:async({project})=>artifactFor(project),
  inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[],coverage:{pages:1,findingsTruncated:false},limitations:lim}),
  render:async()=>({images:[],coverage:{pages:[],complete:false}})});
 assert.equal(out.quality.layout,'clear');assert.equal(out.quality.layoutScope,'observed');assert.equal(out.quality.layoutVerified,false);
 assert.equal(out.quality.inspectionStatus,'partial');assert.deepEqual(out.quality.limitations,lim);assert.equal(out.quality.coverage.pages,1);
});