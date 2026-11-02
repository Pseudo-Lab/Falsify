import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {createLayoutToolHandlers} from '../src/paper-layout-toolbox.mjs';
import {createLayoutPreviewController} from '../src/paper-layout-preview.mjs';
import {layoutStepDecision} from '../src/paper-layout-transport.mjs';
import {createLatexDraftStore} from '../src/latex-draft-store.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(),HASH='a'.repeat(64);
const request={schema:'falsify.paper-layout-agent-step.v1',consent:true,projectId:HASH,step:0,maxSteps:8};
const response={schema:'falsify.paper-layout-agent-action.v1',projectId:HASH,step:0,action:{tool:'finish',args:{},message:'끝'}};
const receipt=(state='completed',extra={})=>({schema:'falsify.layout-step-receipt.v1',runId:'r1',stepId:'r1-s0',fingerprint:HASH,state,result:response,...extra});

test('typed handler adapters keep a previously observed target after editing another paragraph',async()=>{
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\n\\begin{document}\nFirst RED 71 paragraph.\n\nSecond original paragraph.\n\\end{document}')}]});
 const handlers=createLayoutToolHandlers({project});const read=await handlers.inspect_document({project,args:{}}),items=read.observation.blocks.items;
 const a=items.find(b=>b.textPreview.includes('First RED')),b=items.find(b=>b.textPreview.includes('Second original'));assert.ok(b.id.startsWith('lt1_'));
 const updated=await handlers.update_layout({project,args:{blockId:a.id,gapBeforeBp:4}});
 const found=await handlers.get_block({project:updated.project,args:{blockId:b.id}});assert.equal(found.observation.block.id,b.id);assert.match(found.observation.block.text,/Second original/);
 const restored=createLayoutToolHandlers({project:updated.project,targetMetadata:handlers.getTargetMetadata()});assert.equal((await restored.get_block({project:updated.project,args:{blockId:b.id}})).observation.block.id,b.id);
});

test('step transport posts once, then polls matching receipts and returns the selected action',async()=>{
 const calls=[],saved=[];let reads=0;const link={request:async(path,body)=>{calls.push({path,body});return body?receipt('running'):receipt(++reads===1?'running':'completed');}};
 const out=await layoutStepDecision(link,request,{runId:'r1',pollMs:0,onPending:p=>saved.push(p)});assert.equal(out.response.action.tool,'finish');assert.equal(calls.filter(c=>c.body).length,1);assert.equal(calls.filter(c=>!c.body).length,2);assert.equal(saved.at(-1).state,'completed');
});

test('unknown POST is recovered by GET only and wrong fingerprint is refused',async()=>{
 let saved;await assert.rejects(layoutStepDecision({request:async()=>{throw Error('network');}},request,{runId:'r1',onPending:p=>{saved=p;}}),/network/);
 const calls=[];await layoutStepDecision({request:async(path,body)=>{calls.push(body);return receipt();}},request,{runId:'r2',pendingStep:saved,pollMs:0});assert.deepEqual(calls,[null]);
 await assert.rejects(layoutStepDecision({request:async()=>receipt()},request,{runId:'r2',pendingStep:{...saved,fingerprint:'b'.repeat(64)}}),/저장한 요청/);
 await assert.rejects(layoutStepDecision({request:async()=>receipt()},request,{runId:'r2',pendingStep:{...saved,companionInstance:'old'},companionInstance:'new'}),/이전 companion/);
});

test('failed receipt has a disposition and never triggers a second submission',async()=>{
 let calls=0;await assert.rejects(layoutStepDecision({request:async()=>{calls++;return receipt('failed',{error:{message:'모델 실행 실패'}});}},request,{runId:'r1'}),e=>e.disposition==='failed');assert.equal(calls,1);
});

test('content correspondence follows text onto another page and retains ambiguity',async()=>{
 const passage='The complete experimental evidence describes the selected intervention and its exact numerical outcomes for all enrolled participants.';
 const texts={original:['Different unrelated introductory material about another experiment entirely.',passage],candidate:[passage]};
 const input=name=>{const pdfBytes=enc.encode('%PDF-'+name);return {pdfBytes,pdfHash:hex(pdfBytes)};};
 const viewer=createLayoutPreviewController({loadPdf:bytes=>{const name=new TextDecoder().decode(bytes).slice(5);return {promise:Promise.resolve({numPages:texts[name].length,getPage:async n=>({getTextContent:async()=>({items:[{str:texts[name][n-1]}]})})}),destroy(){}};}});
 await viewer.setDocuments({original:input('original'),candidate:input('candidate')});assert.deepEqual((await viewer.findCorrespondingPage({from:'candidate',pageIndex:0})).pageIndex,1);
 texts.original[0]=passage;const duplicate={pdfBytes:enc.encode('%PDF-duplicate'),pdfHash:hex(enc.encode('%PDF-duplicate'))};texts.duplicate=[passage,passage];await viewer.setDocuments({original:duplicate,candidate:input('candidate')});assert.equal((await viewer.findCorrespondingPage({from:'candidate',pageIndex:0})).status,'ambiguous');viewer.dispose();
});

test('source draft storage keeps work in memory on unavailable IDB, respects consent and expiry',async()=>{
 let now=100;const store=createLatexDraftStore({indexedDB:null,now:()=>now});assert.equal((await store.put('private',{consent:false})).persisted,false);assert.equal(await store.get(),null);
 const saved=await store.put('source + candidate',{consent:true});assert.equal(saved.persisted,false);assert.equal((await store.get()).archive,'source + candidate');now+=12*60*60*1000;assert.equal(await store.get(),null);await store.put('later',{consent:true});await store.clear();assert.equal(await store.get(),null);store.dispose();
});

test('failed receipt lookups are tagged for a manual discard and never fall back to POST',async()=>{
 const pending={runId:'r1',stepId:'r1-s0',projectId:HASH,step:0,request,state:'unknown'};const posts=[];
 await assert.rejects(layoutStepDecision({request:async(path,body)=>{if(body)posts.push(body);throw Object.assign(new Error('layout_step_not_found'),{httpStatus:404});}},request,{runId:'r2',pendingStep:pending}),e=>e.recovery==='not-found');
 await assert.rejects(layoutStepDecision({request:async(path,body)=>{if(body)posts.push(body);throw new Error('offline');}},request,{runId:'r2',pendingStep:pending}),e=>e.recovery==='unreachable');
 await assert.rejects(layoutStepDecision({request:async(path,body)=>{if(body)posts.push(body);return receipt();}},request,{runId:'r2',pendingStep:{...pending,companionInstance:'old'},companionInstance:'new'}),e=>e.recovery==='mismatch');
 await assert.rejects(layoutStepDecision({request:async(path,body)=>{if(body)posts.push(body);return receipt();}},{...request,projectId:'b'.repeat(64)},{runId:'r2',pendingStep:pending}),e=>e.recovery==='mismatch');
 assert.deepEqual(posts,[]);
 await assert.rejects(layoutStepDecision({request:async()=>{throw new Error('network');}},request,{runId:'r3'}),e=>e.recovery===undefined);
});


test('known companion_busy 409 is not admitted; a lost POST and other 409s stay recoverable by GET',async()=>{
 const busy=[];let posts=0;
 await assert.rejects(layoutStepDecision({request:async()=>{posts++;throw Object.assign(new Error('secret companion log'),{code:'companion_busy',httpStatus:409});}},request,{runId:'r1',onPending:p=>busy.push(p)}),e=>e.disposition==='not-admitted'&&e.code==='companion_busy'&&e.httpStatus===409&&e.stepReceipt.stepId==='r1-s0'&&e.message.includes('다시 실행')&&!e.message.includes('secret'));
 assert.equal(posts,1);assert.equal(busy[0].state,'unknown');assert.equal(busy.at(-1),null);
 const bridge=[];posts=0;
 await assert.rejects(layoutStepDecision({request:async()=>{posts++;throw Object.assign(new Error('companion_busy'),{httpStatus:409});}},request,{runId:'r1',onPending:p=>bridge.push(p)}),e=>e.disposition==='not-admitted'&&e.code==='companion_busy');
 assert.equal(posts,1);assert.equal(bridge.at(-1),null);
 let lost;await assert.rejects(layoutStepDecision({request:async()=>{throw Error('network');}},request,{runId:'r1',onPending:p=>{lost=p;}}),e=>e.disposition!=='not-admitted'&&/network/.test(e.message));
 assert.equal(lost.state,'unknown');const recovered=[];await layoutStepDecision({request:async(path,body)=>{recovered.push(body);return receipt();}},request,{runId:'r2',pendingStep:lost,pollMs:0});assert.deepEqual(recovered,[null]);
 const conflict=[];await assert.rejects(layoutStepDecision({request:async()=>{throw Object.assign(new Error('layout_step_conflict'),{httpStatus:409});}},request,{runId:'r1',onPending:p=>conflict.push(p)}),e=>e.httpStatus===409&&e.disposition!=='not-admitted'&&e.message==='layout_step_conflict');
 assert.equal(conflict.at(-1).state,'unknown');
 const unlabeled=[];await assert.rejects(layoutStepDecision({request:async()=>{throw Object.assign(new Error('companion_busy'),{httpStatus:503});}},request,{runId:'r1',onPending:p=>unlabeled.push(p)}),e=>e.disposition!=='not-admitted'&&e.message==='companion_busy');
 assert.equal(unlabeled.at(-1).state,'unknown');
 const pending={runId:'r1',stepId:'r1-s0',projectId:HASH,step:0,request,state:'unknown'},lookup=[];
 await assert.rejects(layoutStepDecision({request:async()=>{throw Object.assign(new Error('companion_busy'),{httpStatus:409});}},request,{runId:'r2',pendingStep:pending,onPending:p=>lookup.push(p)}),e=>e.disposition!=='not-admitted'&&e.recovery==='unreachable');
 assert.notEqual(lookup.at(-1),null);
 let polls=0;const admitted=[];
 await assert.rejects(layoutStepDecision({request:async()=>{polls++;return polls===1?receipt('running'):Promise.reject(Object.assign(new Error('companion_busy'),{httpStatus:409}));}},request,{runId:'r1',pollMs:0,onPending:p=>admitted.push(p)}),e=>e.disposition!=='not-admitted'&&e.message==='companion_busy');
 assert.equal(admitted.at(-1).state,'running');
 const done=await layoutStepDecision({request:async()=>receipt()},request,{runId:'r1',pollMs:0});assert.equal(done.response.action.tool,'finish');
 await assert.rejects(layoutStepDecision({request:async()=>receipt()},request,{runId:'r2',pendingStep:{...lost,fingerprint:'b'.repeat(64)}}),/저장한 요청/);
});

test('failed action receipt retains fixed code and request identity without request content',async()=>{
 const {layoutFailureDetails}=await import('../src/paper-layout-transport.mjs');const link={request:async()=>({...receipt('failed'),error:{error:'invalid_action',message:'private model output'}})};
 try{await layoutStepDecision(link,request,{runId:'r1'});assert.fail('expected failed receipt');}catch(e){assert.equal(e.code,'invalid_action');assert.equal(e.disposition,'failed');const detail=layoutFailureDetails(e);assert.equal(detail.code,'invalid_action');assert.equal(detail.request.stepId,'r1-s0');assert.equal(detail.request.fingerprint,receipt('failed').fingerprint);assert.equal(JSON.stringify(detail).includes('private model output'),false);assert.equal('request' in detail.request,false);}
});
