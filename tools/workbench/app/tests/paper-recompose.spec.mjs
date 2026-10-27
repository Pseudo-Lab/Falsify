import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import * as mupdf from 'mupdf';
import {readDocument,normalizeDocument} from '../src/paper-document.mjs';
import {bindEdits,prepare} from '../src/paper-recompose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const fakePdf=new TextEncoder().encode('%PDF-1.7\nfixture');
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){const d=new mupdf.PDFDocument();try{const a=d.addSimpleFont(new mupdf.Font('Helvetica')),b=d.addSimpleFont(new mupdf.Font('Helvetica-Bold'));d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{a,b}},'BT /a 12 Tf 30 300 Td (First value -12) Tj 0 -15 Td /b 12 Tf (continues here) Tj ET BT /a 12 Tf 30 220 Td (repeat) Tj 0 -30 Td (repeat) Tj ET'));const x=d.saveToBuffer();try{return x.asUint8Array().slice();}finally{x.destroy();}}finally{d.destroy();}}
function synthetic(){const chars=(text,x,y)=>[...text].map((text,i)=>({text,bbox:[x+i,y,x+i+1,y+10],fontName:'Helvetica',size:10}));const blocks=[['alpha ',0,10],['bold',6,10],[' words',10,10],['repeat',0,50],['repeat',0,80]].map(([t,x,y])=>({bbox:[x,y,x+t.length,y+10],chars:chars(t,x,y)}));const d=normalizeDocument({sourceSha256:'a'.repeat(64),pages:[{width:300,height:400,blocks,images:[]}]});const [a,b,c,r1,r2]=d.blocks;return {d,flow:{items:[{kind:'paragraph',blockIds:[a.id,b.id,c.id],inline:true,joiners:['','']},{kind:'paragraph',blockIds:[r1.id]},{kind:'paragraph',blockIds:[r2.id]}],fragments:[]}};}
test('cross-block binding replaces once and preserves provenance',()=>{const {d,flow}=synthetic(),original=structuredClone(d);const {bindings,changes}=bindEdits(d,flow,[{id:'x',pageIndex:0,before:'alpha bold words',after:'replacement'}]);assert.deepEqual(changes.map(x=>x.before),['alpha ','bold',' words']);assert.deepEqual(changes.map(x=>x.after),['replacement','','']);assert.equal(bindings[0].parts.length,3);assert.deepEqual(d,original);});
test('repeated quote requires geometry',()=>{const {d,flow}=synthetic();assert.throws(()=>bindEdits(d,flow,[{pageIndex:0,before:'repeat',after:''}]),e=>e.details.code==='AMBIGUOUS_MATCH');const bound=bindEdits(d,flow,[{pageIndex:0,before:'repeat',after:'',anchor:{bbox:[0,75,20,95]}}]);assert.equal(bound.changes[0].blockId,d.blocks[4].id);});
test('real PDF, snapshot and selected edits',async()=>{const bytes=fixture(),original=bytes.slice(),m=await readDocument({file:bytes});assert.ok(m.blocks.some(b=>b.source.lines.length>=2));let compiled;const edits={schema:'falsify.paper-edits.v1',fileHash:sha(bytes),revision:7,edits:[{id:'one',pageIndex:0,before:'First value -12',after:'changed'},{id:'off',pageIndex:0,before:'repeat',after:'bad',enabled:false}]};const result=await prepare({file:bytes,edits},{mupdf,compile:async p=>(compiled=p.source,fakePdf)});assert.equal(result.revision,7);assert.equal(result.bindings.length,1);assert.ok(compiled.includes('changed'));assert.ok(!compiled.includes('bad'));assert.deepEqual(bytes,original);assert.equal(result.sha256,sha(fakePdf));assert.ok(result.file.size);});
test('stale source, numeric mismatch, overlap and cancellation',async()=>{const bytes=fixture(),options={mupdf,compile:async()=>fakePdf};await assert.rejects(prepare({file:bytes,fileHash:'0'.repeat(64),edits:[{pageIndex:0,before:'First',after:'x'}]},options),{code:'stale-source'});await assert.rejects(prepare({file:bytes,edits:[{pageIndex:0,before:'First value 12',after:'x'}]},options),e=>e.details?.code==='NO_MATCH');await assert.rejects(prepare({file:bytes,edits:[{pageIndex:0,before:'First',after:'x'},{pageIndex:0,before:'First value',after:'y'}]},options),e=>e.details?.code==='OVERLAP');const c=new AbortController();await assert.rejects(prepare({file:bytes,signal:c.signal,edits:[{pageIndex:0,before:'First',after:'x'}]},{...options,compile:async()=>{c.abort();return fakePdf;}}),{name:'AbortError'});});

test('fragment split maps back to one parent and deletion spans source blocks',()=>{const {d,flow}=synthetic();const parent=d.blocks[1],r=parent.source.range;const f1={...parent,id:'f1',parentBlockId:parent.id,text:'bo',source:{...parent.source,range:{start:r.start,end:r.start+2},lines:[]}},f2={...parent,id:'f2',parentBlockId:parent.id,text:'ld',source:{...parent.source,range:{start:r.start+2,end:r.end},lines:[]}};flow.fragments=[f1,f2];flow.items[0].blockIds=[d.blocks[0].id,'f1','f2',d.blocks[2].id];flow.items[0].joiners=['','',''];const result=bindEdits(d,flow,[{pageIndex:0,before:'alpha bold words',after:''}]);assert.deepEqual(result.changes.map(x=>x.before),['alpha ','bold',' words']);assert.ok(result.changes.every(x=>x.after===''));});
test('PDF.js checks actual compiler bytes and leaves a finding downloadable',async()=>{const bytes=fixture(),pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href;const out=await prepare({file:bytes,edits:[{pageIndex:0,before:'First value -12',after:'changed'}]},{mupdf,pdfjs,compile:async()=>bytes});assert.equal(out.verification.outputTextCheck,'finding');assert.equal(out.verification.checkReport.readable,true);assert.ok(out.file.size);});

test('line-end punctuation stays literal and wrapped quotes retain raw ranges',()=>{
  const {d,flow}=synthetic(),b=d.blocks[0],start=b.source.range.start;
  const set=(text,split)=>{b.text=text;b.source.range.end=start+text.length;b.source.lines=[{range:{start,end:start+split}},{range:{start:start+split,end:start+text.length}}];flow.items=[{kind:'paragraph',blockIds:[b.id]}];};
  const bind=(before,after='quit')=>bindEdits(d,flow,[{pageIndex:0,before,after}]);
  set('re-sign',3);const original=structuredClone(d);
  assert.throws(()=>bind('resign'),e=>e.details.code==='NO_MATCH');
  for(const before of ['re-sign','re-\nsign']) {const result=bind(before,'  exact\nafter ');assert.equal(result.bindings[0].sourceBefore,'re-sign');assert.deepEqual(result.changes.map(p=>[p.start,p.end,p.before,p.after]),[[start,start+7,'re-sign','  exact\nafter ']]);}
  assert.throws(()=>bind('Re-sign'),e=>e.details.code==='NO_MATCH');assert.deepEqual(d,original);
  for(const sign of ['-','+','−']) {
    set(`${sign}12`,1); const change=bind('12','13').changes[0];
    assert.equal(change.before,'12'); assert.equal(b.text.slice(0,change.start-start)+change.after+b.text.slice(change.end-start),`${sign}13`);
  }
  set('re\u00adsign',7);assert.throws(()=>bind('resign'),e=>e.details.code==='NO_MATCH');assert.equal(bind('re\u00adsign').changes[0].before,'re\u00adsign');
});
test('repeated wrapped literal hyphen remains ambiguous',()=>{const {d,flow}=synthetic(),[a,b]=d.blocks;for(const block of [a,b]){const start=block.source.range.start;block.text='re-sign';block.source.range.end=start+7;block.source.lines=[{range:{start,end:start+3}},{range:{start:start+3,end:start+7}}];}flow.items=[a,b].map(block=>({kind:'paragraph',blockIds:[block.id]}));assert.throws(()=>bindEdits(d,flow,[{pageIndex:0,before:'re-\nsign',after:'quit'}]),e=>e.details.code==='AMBIGUOUS_MATCH');});
test('explicit empty and disabled edits use the baseline pipeline',async()=>{const bytes=fixture(),options={mupdf,compile:async()=>fakePdf};for(const edits of [[],[{pageIndex:0,before:'absent',after:'x',enabled:false}]]){const original=structuredClone(edits);const result=await prepare({file:bytes,edits},options);assert.equal(result.sourceBinding.editCount,0);assert.deepEqual(edits,original);assert.ok(result.file.size);}});
test('hint at a fragment boundary preserves the parent raw range',()=>{const {d,flow}=synthetic(),b=d.blocks[1],start=b.source.range.start;b.source.wordSpaceOffsets=[start+2];const f1={...b,id:'f1',parentBlockId:b.id,text:'bo',source:{...b.source,range:{start,end:start+2},lines:[]}},f2={...b,id:'f2',parentBlockId:b.id,text:'ld',source:{...b.source,range:{start:start+2,end:start+4},lines:[]}};flow.fragments=[f1,f2];flow.items[0].blockIds=[d.blocks[0].id,'f1','f2',d.blocks[2].id];flow.items[0].joiners=['','',''];const result=bindEdits(d,flow,[{pageIndex:0,before:'alpha bo ld words',after:'x'}]);assert.equal(result.bindings[0].sourceBefore,'alpha bold words');});

test('explicit native selection retains quote provenance and exact replacement',()=>{
  const {d,flow}=synthetic(), b=d.blocks[0], start=b.source.range.start;
  b.text='re-sign'; b.source.range.end=start+7; flow.items=[{kind:'paragraph',blockIds:[b.id]}];
  const edits=[{id:'x',pageIndex:0,before:'resign',after:'  exact\nafter '}], original=structuredClone(d);
  assert.throws(()=>bindEdits(d,flow,edits),e=>e.details.code==='NO_MATCH');
  const selection={id:'x',sourceSha256:d.sourceSha256,parts:[{blockId:b.id,pageIndex:0,start,end:start+7,before:'re-sign'}]};
  const result=bindEdits(d,flow,edits,[selection]);
  assert.equal(result.bindings[0].matchMethod,'explicit-source'); assert.equal(result.bindings[0].before,'resign'); assert.equal(result.bindings[0].sourceBefore,'re-sign'); assert.equal(result.changes[0].after,'  exact\nafter '); assert.deepEqual(d,original);
});
test('explicit parts validate source, flow ownership, order and overlap',()=>{
  const {d,flow}=synthetic(), [a,b,c]=d.blocks;
  const part=x=>({blockId:x.id,pageIndex:0,start:x.source.range.start,end:x.source.range.end,before:x.text});
  const selection={index:0,sourceSha256:d.sourceSha256,parts:[part(a),part(b),part(c)]}, edits=[{id:'x',pageIndex:0,before:'different',after:'new'}];
  const bind=s=>bindEdits(d,flow,edits,[s]);
  assert.deepEqual(bind(selection).changes.map(p=>p.after),['new','','']);
  for(const parts of [[part(b),part(a)],[part(a),part(c)],[{...part(a),before:'wrong'}],[{...part(a),pageIndex:1}],[{...part(a),end:part(a).end+1}]]) assert.throws(()=>bind({...selection,parts}),{code:'source-binding'});
  assert.throws(()=>bind({...selection,sourceSha256:'0'.repeat(64)}),{code:'stale-source'});
  const assetFlow=structuredClone(flow); assetFlow.items=[{kind:'paragraph',blockIds:[a.id]},{kind:'asset',blockIds:[b.id]},{kind:'paragraph',blockIds:[c.id]}];
  assert.throws(()=>bindEdits(d,assetFlow,edits,[selection]),{code:'source-binding'});
  assert.throws(()=>bindEdits(d,flow,[...edits,{id:'x',pageIndex:0,before:'bold',after:'y'}]),{code:'invalid-edit'});
  assert.throws(()=>bindEdits(d,flow,[...edits,{id:'y',pageIndex:0,before:'bold',after:'y'}],[selection]),e=>e.details.code==='OVERLAP');
  assert.throws(()=>bindEdits(d,flow,edits,[selection,selection]),{code:'source-binding'});
  assert.equal(bindEdits(d,flow,[{...edits[0],enabled:false}],[selection]).bindings.length,0);
});
test('explicit native offsets include non-BMP text and mixed block styles',()=>{
  const {d,flow}=synthetic(),[a,b]=d.blocks; const start=a.source.range.start;
  a.text='A😀';a.source.range.end=start+a.text.length; flow.items=[{kind:'paragraph',blockIds:[a.id,b.id]}];
  const parts=[a,b].map(x=>({blockId:x.id,pageIndex:0,start:x.source.range.start,end:x.source.range.end,before:x.text}));
  const result=bindEdits(d,flow,[{pageIndex:0,before:'different',after:'done'}],[{index:0,sourceSha256:d.sourceSha256,parts}]);
  assert.equal(result.bindings[0].sourceBefore,'A😀bold');assert.deepEqual(result.changes.map(p=>p.after),['done','']);
});

test('prepare accepts explicit source parts using original edit index',async()=>{
  const bytes=fixture(), document=await readDocument({file:bytes}), block=document.blocks.find(b=>b.text.includes('First value -12'));
  const start=block.source.range.start+block.text.indexOf('First value -12'); let compiled;
  const result=await prepare({file:bytes,edits:[{enabled:false},{id:'chosen',pageIndex:0,before:'external quote',after:'changed'}],bindings:[{index:1,sourceSha256:document.sourceSha256,parts:[{blockId:block.id,pageIndex:0,start,end:start+15,before:'First value -12'}]}]},{mupdf,compile:async p=>(compiled=p.source,fakePdf)});
  assert.equal(result.bindings[0].matchMethod,'explicit-source');assert.equal(result.bindings[0].before,'external quote');assert.equal(result.bindings[0].sourceBefore,'First value -12');assert.ok(compiled.includes('changed'));
});
test('duplicate flow ownership is rejected for explicit selection',()=>{
  const {d,flow}=synthetic(),b=d.blocks[0];flow.items.push({kind:'paragraph',blockIds:[b.id]});
  const part={blockId:b.id,pageIndex:0,start:b.source.range.start,end:b.source.range.end,before:b.text};
  assert.throws(()=>bindEdits(d,flow,[{pageIndex:0,before:'other',after:'x'}],[{index:0,sourceSha256:d.sourceSha256,parts:[part]}]),e=>e.details.code==='AMBIGUOUS_EXPLICIT');
});

test('File-like input bytes remain owned through subsequent readers',async()=>{
  const bytes=fixture(), borrowed=bytes.slice().buffer;
  const pdfjs={getDocument(){new Uint8Array(borrowed).fill(0);return {promise:Promise.resolve({numPages:0}),destroy:async()=>{}};}};
  let compiled;
  const result=await prepare({file:{arrayBuffer:async()=>borrowed},edits:[]},{mupdf,pdfjs,compile:async p=>(compiled=p.source,fakePdf)});
  assert.equal(result.sourceBinding.sourceSha256,sha(bytes));
  assert.ok(compiled.includes('First value'));
  assert.ok(new Uint8Array(borrowed).every(value=>value===0));
  assert.ok(result.file.size);
});


test('explicit parts cannot split a surrogate pair',()=>{
  const {d,flow}=synthetic(), b=d.blocks[0], start=b.source.range.start;
  b.text='A😀B'; b.source.range.end=start+b.text.length; flow.items=[{kind:'paragraph',blockIds:[b.id]}];
  const select=(from,to)=>({index:0,sourceSha256:d.sourceSha256,parts:[{blockId:b.id,pageIndex:0,start:start+from,end:start+to,before:b.text.slice(from,to)}]});
  const edits=[{pageIndex:0,before:'other',after:'x'}];
  for(const [from,to] of [[0,2],[2,4]]) assert.throws(()=>bindEdits(d,flow,edits,[select(from,to)]),e=>e.details.code==='INVALID_EXPLICIT');
  assert.equal(bindEdits(d,flow,edits,[select(1,3)]).changes[0].before,'😀');
});

test('prepare snapshots explicit selection and source inputs before reading a File',async()=>{
  const bytes=fixture(), document=await readDocument({file:bytes}), block=document.blocks.find(b=>b.text.includes('First value -12'));
  const start=block.source.range.start+block.text.indexOf('First value -12'), originalSignal=new AbortController().signal;
  const request={fileHash:sha(bytes),revision:4,signal:originalSignal,edits:[{id:'chosen',pageIndex:0,before:'external quote',after:'changed'}],bindings:[{id:'chosen',sourceSha256:document.sourceSha256,parts:[{blockId:block.id,pageIndex:0,start,end:start+15,before:'First value -12'}]}]};
  request.file={async arrayBuffer(){request.bindings[0].parts[0].before='mutated'; request.fileHash='0'.repeat(64); request.revision=9; const c=new AbortController(); c.abort(); request.signal=c.signal; return bytes.slice().buffer;}};
  const result=await prepare(request,{mupdf,compile:async()=>fakePdf});
  assert.equal(result.bindings[0].sourceBefore,'First value -12'); assert.equal(result.revision,4);
});
