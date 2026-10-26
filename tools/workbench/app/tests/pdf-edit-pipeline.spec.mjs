import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepare} from '../src/pdf-edit-pipeline.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),pdf=label=>new TextEncoder().encode('%PDF-1.7\n'+label+'\n%%EOF');
const input=pdf('original'),aBytes=pdf('table'),bBytes=pdf('table-and-body');
const identity=[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i,continuationPageIndices:[]}));
const edits=()=>[{id:'t',segmentId:'table:0:cell',pageIndex:0,before:'10',after:'11',anchor:{bbox:[20,20,30,30],occurrence:0}}, {id:'b',segmentId:'paragraph:1:body',pageIndex:1,before:'Before',after:'Long after',anchor:{bbox:[20,20,100,80],occurrence:3}}];
const request=()=>({file:new File([input],'original.pdf'),fileHash:sha(input),edits:edits()});
function result(bytes,inputHash,status='applied',extra={}){return {file:new File([bytes],'actual.pdf'),sha256:sha(bytes),pageMap:structuredClone(identity),verification:{sourceSha256:inputHash,outputSha256:sha(bytes),status,pageCount:{source:2,output:2},checks:[],edits:[]},warnings:[],...extra};}
function engines(overrides={}){return {selectionPdf:{prepare:async r=>result(aBytes,r.fileHash)},paragraphPdf:{prepare:async r=>result(bBytes,r.fileHash)},...overrides};}

test('ordered actual hash chain preserves original bindings, copies table ordinals and embedded snapshot hash',async()=>{
  const req=request(),saved=structuredClone(req.edits),calls=[];req.edits={schema:'falsify.paper-edits.v1',fileHash:req.fileHash,revision:8,edits:req.edits};
  const out=await prepare(req,engines({selectionPdf:{prepare:async r=>{calls.push('A');assert.equal(sha(r.file),sha(input));assert.equal(r.fileHash,sha(input));assert.equal(r.edits.edits.length,1);assert.equal(r.edits.edits[0].anchor.occurrence,undefined);r.edits.edits[0].after='engine-local';return result(aBytes,r.fileHash);}},paragraphPdf:{prepare:async r=>{calls.push('B');assert.equal(sha(r.file),sha(aBytes));assert.equal(r.fileHash,sha(aBytes));assert.equal(r.edits.fileHash,sha(aBytes));assert.equal(r.edits.edits[0].pageIndex,1);assert.equal(r.edits.edits[0].anchor.occurrence,3);return result(bBytes,r.fileHash);}}}));
  assert.deepEqual(calls,['A','B']);assert.deepEqual(req.edits.edits,saved);assert.equal(out.originalSourceSha256,sha(input));assert.equal(out.sha256,sha(bBytes));assert.equal(out.verification.sourceSha256,sha(input));assert.equal(out.verification.independent,false);assert.equal(out.verification.layoutVerified,false);
  assert.deepEqual(out.verification.stages.map(s=>[s.inputSha256,s.outputSha256]),[[sha(input),sha(aBytes)],[sha(aBytes),sha(bBytes)]]);assert.equal(out.verification.stages[1].verification.sourceSha256,sha(aBytes));assert.equal(out.verification.bodyPending,false);
});
test('same-page body copies rebind geometry after a table quote count changes',async()=>{
  const req=request();req.edits[1]={...req.edits[1],pageIndex:0,before:'10',after:'12',anchor:{occurrence:12,bbox:[100,50,115,60]}};
  const original=structuredClone(req.edits);
  await prepare(req,engines({paragraphPdf:{prepare:async r=>{
    assert.equal(r.fileHash,sha(aBytes));assert.equal(r.edits[0].anchor.occurrence,undefined);
    assert.deepEqual(r.edits[0].anchor.bbox,[100,50,115,60]);return result(bBytes,r.fileHash);
  }}}));
  assert.deepEqual(req.edits,original,'original source ordinal remains in the experiment record');
});

test('single-kind behavior delegates request and result unchanged',async()=>{
  for(const table of [true,false]){const req=request();req.edits=req.edits.filter(e=>table?e.id==='t':e.id==='b');const answer={unchanged:true};const api={prepare:async r=>{assert.equal(r,req);return answer;}};assert.equal(await prepare(req,{selectionPdf:api,paragraphPdf:api}),answer);}
});
test('stage A readable failed quality returns actual A with body pending and never runs B',async()=>{
  let calls=0;const a=result(aBytes,sha(input),'failed');const out=await prepare(request(),engines({selectionPdf:{prepare:async()=>a},paragraphPdf:{prepare:async()=>{calls++;}}}));assert.equal(calls,0);assert.ok(out.file instanceof File);assert.equal(sha(new Uint8Array(await out.file.arrayBuffer())),sha(aBytes));assert.equal(out.verification.status,'failed');assert.equal(out.verification.bodyPending,true);assert.deepEqual(out.verification.pendingEditIds,['b']);assert.ok(out.warnings.some(w=>w.code==='mixed-table-stage-not-passed'));
});
test('quality/check failures override applied labels; warnings and readable body drafts remain explicit',async()=>{
  for(const aStatus of ['unverified','applied']){const a=result(aBytes,sha(input),aStatus);if(aStatus==='applied')a.verification.checks=[{status:'failed',code:'outside-change'}];let ran=false;const out=await prepare(request(),engines({selectionPdf:{prepare:async()=>a},paragraphPdf:{prepare:async()=>{ran=true;}}}));assert.equal(out.verification.status,'failed');assert.equal(ran,false);}
  for(const status of ['warning','failed','draft']){const out=await prepare(request(),engines({paragraphPdf:{prepare:async r=>result(bBytes,r.fileHash,status)}}));assert.equal(out.verification.status,status);assert.equal(out.verification.bodyPending,false);assert.equal(out.verification.stages[1].status,status);}
});
test('stage A identity/page-count/source binding must hold before B',async()=>{
  for(const alter of [a=>a.pageMap[0].outputPageIndex=1,a=>a.pageMap[0].continuationPageIndices=[1],a=>a.verification.pageCount.output=3,a=>delete a.pageMap,a=>a.pageMap[0].contentOutputPageIndices=[1]]){
    const a=result(aBytes,sha(input));alter(a);let ran=false;await assert.rejects(()=>prepare(request(),engines({selectionPdf:{prepare:async()=>a},paragraphPdf:{prepare:async()=>{ran=true;}}})),{code:'stage-one-page-map-not-identity'});assert.equal(ran,false);
  }
});
test('hash mismatch, stage source lie and mutable A file are refused; no fabricated fallback',async()=>{
  await assert.rejects(()=>prepare({...request(),fileHash:'0'.repeat(64)},engines()),{code:'stale-source'});
  for(const which of ['A','B']){const bad=result(which==='A'?aBytes:bBytes,which==='A'?sha(input):sha(aBytes));bad.sha256='0'.repeat(64);await assert.rejects(()=>prepare(request(),engines(which==='A'?{selectionPdf:{prepare:async()=>bad}}:{paragraphPdf:{prepare:async()=>bad}})),{code:'output-hash-mismatch'});}
  const lie=result(aBytes,'0'.repeat(64));await assert.rejects(()=>prepare(request(),engines({selectionPdf:{prepare:async()=>lie}})),{code:'stage-source-hash-mismatch'});
  let reads=0;const changing=result(aBytes,sha(input));changing.file={arrayBuffer:async()=>((++reads===1?aBytes:bBytes).slice().buffer)};await assert.rejects(()=>prepare(request(),engines({selectionPdf:{prepare:async()=>changing}})),{code:'stage-one-file-changed'});
  const boom=new Error('native failure');await assert.rejects(()=>prepare(request(),engines({paragraphPdf:{prepare:async()=>{throw boom;}}})),e=>e===boom);
});
test('aborted stage A never starts B; same-page unknown/overlapping spans refused before engines',async()=>{
  const ctl=new AbortController();let calls=0;await assert.rejects(()=>prepare({...request(),signal:ctl.signal},engines({selectionPdf:{prepare:async r=>{ctl.abort();return result(aBytes,r.fileHash);}},paragraphPdf:{prepare:async()=>{calls++;}}})),{code:'aborted'});assert.equal(calls,0);
  for(const unknown of [false,true]){const req=request();req.edits[1].pageIndex=0;if(unknown)delete req.edits[1].anchor;else req.edits[1].anchor.bbox=[20,20,40,40];await assert.rejects(()=>prepare(req,engines()),{code:unknown?'mixed-overlap-unverifiable':'overlapping-edits'});}
});
test('abort during stage B and original-file read never returns a late candidate',async()=>{
  const ctl=new AbortController();await assert.rejects(()=>prepare({...request(),signal:ctl.signal},engines({paragraphPdf:{prepare:async r=>{ctl.abort();return result(bBytes,r.fileHash);}}})),{code:'aborted'});
  const early=new AbortController();let ran=false;const req={...request(),signal:early.signal,file:{arrayBuffer:async()=>{early.abort();return input.slice().buffer;}}};await assert.rejects(()=>prepare(req,engines({selectionPdf:{prepare:async()=>{ran=true;}}})),{code:'aborted'});assert.equal(ran,false);
});
test('mutable final B and failed early A File-like results become immutable verified Files',async()=>{
  for(const early of [false,true]){
    let reads=0;const expected=early?aBytes:bBytes,unverified=pdf('UNVERIFIED');
    const staged=result(expected,early?sha(input):sha(aBytes),early?'failed':'applied');
    staged.file={name:'../unsafe\u0000name',arrayBuffer:async()=>((++reads===1?expected:unverified).slice().buffer)};
    const out=await prepare(request(),engines(early?{selectionPdf:{prepare:async()=>staged}}:{paragraphPdf:{prepare:async()=>staged}}));
    assert.equal(reads,1);assert.ok(out.file instanceof File);assert.equal(out.file.type,'application/pdf');assert.ok(out.file.name.endsWith('.pdf'));assert.doesNotMatch(out.file.name,/[\/\\\u0000]/);
    for(let i=0;i<2;i++)assert.equal(sha(new Uint8Array(await out.file.arrayBuffer())),out.sha256);
    assert.equal(out.sha256,sha(expected));assert.equal(out.verification.status,early?'failed':'applied');
  }
});
test('ArrayBuffer callback bytes are owned immediately, including mutable SharedArrayBuffer views',async()=>{
  const subtle=crypto.subtle,real=subtle.digest.bind(subtle);
  for(const scenario of ['source','failed-A','final-B']){
    const expected=scenario==='source'?input:scenario==='failed-A'?aBytes:bBytes,shared=new SharedArrayBuffer(expected.length),view=new Uint8Array(shared);view.set(expected);
    let changed=false;subtle.digest=(algorithm,data)=>{if(!changed&&sha(new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength))===sha(expected)){changed=true;view.fill(0);}return real(algorithm,data);};
    try{
      const req=request(),file={name:'shared.pdf',arrayBuffer:async()=>view};let apis=engines();
      if(scenario==='source')req.file=file;
      else if(scenario==='failed-A')apis=engines({selectionPdf:{prepare:async r=>({...result(aBytes,r.fileHash,'failed'),file})}});
      else apis=engines({paragraphPdf:{prepare:async r=>({...result(bBytes,r.fileHash),file})}});
      const out=await prepare(req,apis);assert.equal(changed,true);assert.equal(out.sha256,sha(scenario==='failed-A'?aBytes:bBytes));assert.equal(sha(new Uint8Array(await out.file.arrayBuffer())),out.sha256);
    }finally{subtle.digest=real;}
  }
});
test('original abort cannot be bypassed by replacing request signal or control fields inside A',async()=>{
  const req=request(),original=new AbortController(),replacement=new AbortController();req.signal=original.signal;req.revision=7;let bodyCalls=0;
  await assert.rejects(()=>prepare(req,engines({selectionPdf:{prepare:async r=>{assert.equal(r.signal,original.signal);assert.equal(r.revision,7);original.abort();req.signal=replacement.signal;req.revision=99;req.fileHash=sha(bBytes);return result(aBytes,r.fileHash);}},paragraphPdf:{prepare:async()=>{bodyCalls++;}}})),{code:'aborted'});assert.equal(bodyCalls,0);
  const stable=request(),signal=new AbortController().signal;stable.signal=signal;stable.revision=7;
  const out=await prepare(stable,engines({selectionPdf:{prepare:async r=>{stable.signal=new AbortController().signal;stable.revision=99;return result(aBytes,r.fileHash);}},paragraphPdf:{prepare:async r=>{assert.equal(r.signal,signal);assert.equal(r.revision,7);return result(bBytes,r.fileHash);}}}));assert.equal(out.verification.status,'applied');
});
test('all contradictory/unknown per-edit, check and report states stop A before B; applied/noop accepted',async()=>{
  const mutations=[...['after-missing','unapplied','error','planned','mystery',null].map(status=>v=>v.edits=[{id:'t',status}]),v=>v.checks=[{status:'unknown'}],v=>v.report={ok:false},v=>v.report={selfCheck:{status:'failed',ok:false}},v=>v.report={edits:[{id:'t',status:'after-missing'}]},v=>v.selfCheck={status:'error'}];
  for(const mutate of mutations){const a=result(aBytes,sha(input));mutate(a.verification);let calls=0;const out=await prepare(request(),engines({selectionPdf:{prepare:async()=>a},paragraphPdf:{prepare:async()=>{calls++;}}}));assert.equal(calls,0);assert.equal(out.verification.status,'failed');assert.equal(out.verification.bodyPending,true);}
  const a=result(aBytes,sha(input));a.verification.edits=[{id:'t',status:'noop'}];a.verification.report={ok:true,status:'self-check-passed',edits:[{status:'applied'}],selfCheck:{status:'passed',ok:true,failures:[]}};
  assert.equal((await prepare(request(),engines({selectionPdf:{prepare:async()=>a}}))).verification.status,'applied');
});

const checkout=process.env.FALSIFY_TEST_WORKBENCH||resolve(import.meta.dirname,'../..'),app=resolve(checkout,'app');
const realAvailable=existsSync(resolve(app,'node_modules/mupdf/dist/mupdf.js'))&&existsSync(resolve(app,'dist/paragraph-vendor/editcore.wasm'));
test('real repeated table cell plus long body composition preserves both edits and other eleven cells',{skip:!realAvailable&&'Installed Workbench engines unavailable; set FALSIFY_TEST_WORKBENCH'},async()=>{
  const mupdf=await import(pathToFileURL(resolve(app,'node_modules/mupdf/dist/mupdf.js')).href),selectionPdf=await import(pathToFileURL(resolve(app,'dist/browser-pdf.mjs')).href),paragraphPdf=await import(pathToFileURL(resolve(app,'dist/paragraph-pdf.mjs')).href);
  const {detectSourceTables,selectTableCell}=await import('../src/table-adapter.mjs');
  const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  let table='0 0 0 RG .5 w\n';for(const x of [40,160,280])table+=`${x} 440 m ${x} 720 l S\n`;for(let i=0;i<=14;i++)table+=`40 ${720-i*20} m 280 ${720-i*20} l S\n`;for(let i=0;i<13;i++)for(const [x,s]of [[50,i?'Row'+i:'Name'],[170,i?'10':'Value']])table+=`BT /F1 8 Tf ${x} ${707-i*20} Td (${s}) Tj ET\n`;
  const before='Original paragraph has enough words to establish a reasonable source column width.';
  const body=`BT /F1 12 Tf 72 700 Td (${before}) Tj 0 -25 Td (Following paragraph remains readable.) Tj 0 -475 Td (Lower body paragraph gives the column room to grow.) Tj 0 -165 Td (2) Tj ET`;
  for(const content of [table,body])d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{F1:font}},content));
  const source=new Uint8Array(d.saveToBuffer().asUint8Array());d.destroy();const original=source.slice();
  const model=await detectSourceTables({sourceBytes:source,sourceSha256:sha(source),revision:'r1',mupdf}),t=model.tables.find(t=>t.pageIndex===0),cell=t.cells.find(c=>c.row===12&&c.col===1),selected=selectTableCell(model,{tableId:t.id,cellId:cell.id,sourceSha256:sha(source),revision:'r1'});assert.equal(selected.status,'ready');
  const savedFetch=globalThis.fetch;globalThis.fetch=async input=>{const url=new URL(input);assert.equal(url.protocol,'file:');assert.ok(url.pathname.includes('/paragraph-vendor/'));return new Response(readFileSync(url));};
  try{
    const after='Every requested sentence remains present while the paragraph expands in its original column. '.repeat(4).trim();
    const out=await prepare({file:new File([source],'mixed.pdf'),fileHash:sha(source),edits:[{id:'table-last',segmentId:'table:0:last',pageIndex:0,before:'10',after:'11',anchor:{...selected.anchor,occurrence:0}},{id:'body-long',segmentId:'paragraph:1:first',pageIndex:1,before,after}]},{selectionPdf,paragraphPdf});
    assert.ok(['applied','warning'].includes(out.verification.status),JSON.stringify(out.verification));assert.equal(out.verification.stages.length,2);assert.equal(out.verification.stages[1].inputSha256,out.verification.stages[0].outputSha256);
    const finalBytes=new Uint8Array(await out.file.arrayBuffer());assert.equal(sha(finalBytes),out.sha256);assert.deepEqual(source,original);
    const doc=mupdf.Document.openDocument(finalBytes,'application/pdf');const texts=[];try{for(let i=0;i<doc.countPages();i++){const p=doc.loadPage(i),s=p.toStructuredText();texts.push(s.asText());s.destroy();p.destroy();}}finally{doc.destroy();}
    assert.equal((texts[0].match(/\b10\b/g)||[]).length,11);assert.equal((texts[0].match(/\b11\b/g)||[]).length,1);assert.ok(texts.slice(1).join(' ').replace(/\s+/g,' ').includes(after));assert.ok(texts.join(' ').includes('Following paragraph remains readable.'));
  }finally{globalThis.fetch=savedFetch;}
});
