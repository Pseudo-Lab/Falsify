import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument,typstString} from '../src/paper-compose.mjs';
import {compileInWorker} from '../src/paper-compose-worker.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const src=new TextEncoder().encode('source'); const sha=b=>createHash('sha256').update(b).digest('hex');
const make=()=>({schema:'falsify.paper-document.v1',sourceSha256:sha(src),pages:[{sourcePageIndex:0,width:400,height:600}],blocks:[{id:'a',text:'repeat hard-repeat −12 [1]',source:{pageIndex:0,range:{start:0,end:26},lines:[{range:{start:0,end:12}},{range:{start:12,end:26}}]}},{id:'b',text:'repeat',source:{pageIndex:0,range:{start:26,end:32},lines:[]}}],assets:[]});
const pdf=new TextEncoder().encode('%PDF-1.7\nactual bytes');
const edit={blockId:'b',pageIndex:0,start:26,end:32,before:'repeat',after:'changed'};
test('markers do not insert spaces and source tabs keep a word separator',async()=>{
 const d=make();d.blocks=[{id:'x',text:'102.\tGilbert',source:{pageIndex:0,range:{start:0,end:12},lines:[]}}];let source,checked;
 await composeDocument({document:d,sourceBytes:src},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.doesNotMatch(source,/here\(\)\.position\(\); #metadata/);assert.match(source,/#text\("102\."\)#text\(" "\)#text\("Gilbert"\)/);assert.equal(checked[0].text,'102.\tGilbert');
});
test('explicit After line breaks retain an encoded separator and the full replacement',async()=>{
 const d=make(), after='exact expres-\nsion continues';let source,checked;
 await composeDocument({document:d,sourceBytes:src,edits:[{...edit,after}]},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.match(source,/#text\("exact expres-"\)#text\(" "\)#linebreak\(\)#text\("sion continues"\)/);
 assert.equal(checked[1].text,after);
});
test('captions above and below an asset follow source position in output and checks',async()=>{
 const d=make(), bounds=[50,100,350,200];
 d.blocks=[{id:'top',text:'Table 1',source:{pageIndex:0,range:{start:0,end:7},lines:[]}},{id:'bottom',text:'Footnote',source:{pageIndex:0,range:{start:7,end:15},lines:[]}},{id:'picture',text:'',source:{pageIndex:0,bbox:bounds},assetIds:['image']}];
 d.assets=[{id:'image',source:{pageIndex:0,bbox:bounds},content:{representation:'svg',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="300" height="100"/></svg>')}}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'table',kind:'asset',source:{pageIndex:0,bbox:bounds},blockIds:['picture'],assetIds:['image'],captionIds:['bottom','top'],captionPositions:{top:'above',bottom:'below'}},{kind:'caption',blockIds:['bottom']},{kind:'caption',blockIds:['top']} ]};
 const original=structuredClone(d);let source,expected;
 await composeDocument({document:d,sourceBytes:src,flow},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.ok(source.indexOf(typstString('Table 1'))<source.indexOf('#image('));
 assert.ok(source.indexOf('#image(')<source.indexOf(typstString('Footnote')));
 assert.match(source,/\]\n\n#block\(sticky: true\)\[#box\(width: 300pt, height: 100pt, baseline: 100pt\)\[/);
 assert.match(source,/#place\(top \+ left\)\[#box\(width: 0pt, height: 0pt\)/);
 assert.match(source,/#place\(bottom \+ left\)\[#box\(width: 0pt, height: 0pt\)/);
 assert.match(source,/\]\]\n\n#context \[/);
 assert.deepEqual(expected.map(b=>b.text),['Table 1','Footnote']);assert.deepEqual(d,original);
});
test('literal source, unique edits, line boundaries and immutable model',async()=>{const d=make(),original=structuredClone(d);let source;const malicious='#import "https://bad"\n\\" ] #panic() Ω';const out=await composeDocument({document:d,sourceBytes:src,edits:[{...edit,after:malicious}]},{compile:async p=>(source=p.source,pdf)});assert.deepEqual(d,original);for (const part of malicious.split('\n')) assert.ok(source.includes(typstString(part)));assert.ok(source.includes(typstString('repeat hard-repeat −12 [1]')));assert.equal(out.sha256,sha(pdf));assert.deepEqual(new Uint8Array(await out.file.arrayBuffer()),pdf);assert.equal(out.verification.contentVerified,false);assert.equal(out.pageMap,null);assert.equal(out.blockMap,null);assert.equal(out.verification.coverage.status,'unavailable');});
test('rejects mismatched, duplicate and overlapping edit targets',async()=>{const d=make(),compile=async()=>pdf;for(const edits of [[{...edit,before:'wrong'}],[edit,edit],[{...edit,blockId:'missing'}]])await assert.rejects(composeDocument({document:d,sourceBytes:src,edits},{compile}));d.blocks.push({...d.blocks[1]});await assert.rejects(composeDocument({document:d,sourceBytes:src,edits:[edit]},{compile}));});
test('checks source hash and cancellation after async compile',async()=>{const d=make();await assert.rejects(composeDocument({document:d,sourceBytes:new Uint8Array([1])},{compile:async()=>pdf}),/hash/);const c=new AbortController();await assert.rejects(composeDocument({document:d,sourceBytes:src,signal:c.signal},{compile:async()=>{c.abort();return pdf;}}),{name:'AbortError'});});
test('coverage reports Omega and unsupported character without claiming preservation',async()=>{const d=make();d.blocks[1].text='Ω'+String.fromCodePoint(0x10ffff);d.blocks[1].source.range.end=29;const result=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf,fonts:{hasGlyph:cp=>cp!==0x10ffff}});assert.deepEqual(result.verification.coverage.missing,[0x10ffff]);assert.equal(result.verification.contentVerified,false);});
test('worker abort terminates owned worker',async()=>{const c=new AbortController();let terminated=0;const w={postMessage(){c.abort();},terminate(){terminated++;}};await assert.rejects(compileInWorker(w,{},c.signal),{name:'AbortError'});assert.equal(terminated,1);});
test('figure with no source range is reported as unsupported rather than silently preserved',async()=>{const d=make();d.blocks.push({id:'fig',kind:'figure',text:'',source:{pageIndex:0},assetIds:['asset']});d.assets=[{id:'asset'}];const out=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf});assert.match(out.warnings.join(' '),/not placed/);assert.equal(out.verification.contentVerified,false);});

 test('snapshots inputs and compiler bytes across awaits',async()=>{
 const d=make(), input=src.slice(), e={...edit}, bytes=pdf.slice(); let release;
 const gate=new Promise(r=>release=r); let captured;
 const pending=composeDocument({document:d,sourceBytes:input,edits:[e]},{fonts:{hasGlyph:async()=>{await gate; return true}},compile:async p=>{captured=p.source; return bytes},outputCheck:async ({bytes:checked,expectedBlocks})=>{bytes.fill(0); assert.equal(expectedBlocks[1].text,'changed'); assert.deepEqual(checked,pdf); return {checks:{content:{status:'pass'}},findings:[]}}});
 d.blocks[1].text='mutated'; d.pages[0].width=1; e.after='mutated'; input.fill(0); release();
 const result=await pending; assert.ok(captured.includes(typstString('changed'))); assert.equal(result.verification.edits[0].status,'bound'); assert.equal(result.sha256,sha(pdf)); assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()),pdf); assert.equal(result.verification.contentVerified,true);
 });
 test('line boundaries retain hard hyphens, source whitespace and minus; selected After remains literal',async()=>{
 const d=make(); d.blocks=[{id:'x',text:'hard-repeat keep  space −12',source:{pageIndex:0,range:{start:0,end:27},lines:[{range:{start:0,end:5}},{range:{start:5,end:12}},{range:{start:12,end:17}},{range:{start:17,end:27}}]}}]; let captured;
 await composeDocument({document:d,sourceBytes:src,edits:[{blockId:'x',pageIndex:0,start:0,end:11,before:'hard-repeat',after:'new-word'}]},{compile:async p=>(captured=p.source,pdf)}); assert.ok(captured.includes(typstString('new-word keep  space −12')));
 });
 test('checker mismatch remains a finding and draft is downloadable',async()=>{const out=await composeDocument({document:make(),sourceBytes:src},{compile:async()=>pdf,outputCheck:async()=>({checks:{content:{status:'unavailable'}},findings:[{code:'content-mismatch'}]})});assert.equal(out.verification.outputTextCheck,'finding');assert.equal(out.verification.status,'finding');assert.equal(out.file.size,pdf.length);});


test('source-to-logical edit mapping keeps boundaries and literal neighbors',async()=>{
 const cases=[
  ['helloworld',[5],5,10,'earth','hello earth'],
  ['helloworld',[5],0,5,'hi','hi world'],
  ['helloworld',[5],3,7,'X','helXrld'],
  ['helloworld',[5],5,10,'','hello '],
  ['hello world',[5],6,11,'earth','hello earth'],
  ['hard-repeat',[5],5,11,'word','hard-word'],
  ['hard-repeat',[5],0,5,'soft-','soft-repeat'],
  ['−12',[1],1,3,'34','−34'],
 ];
 for(const [raw,bounds,start,end,after,expected] of cases){
  const d=make(); const points=[0,...bounds,raw.length];
  d.blocks=[{id:'x',text:raw,source:{pageIndex:0,range:{start:0,end:raw.length},lines:points.slice(1).map((end,i)=>({range:{start:points[i],end}}))}}];
  const original=structuredClone(d); let captured, checkedText;
  const out=await composeDocument({document:d,sourceBytes:src,edits:[{blockId:'x',pageIndex:0,start,end,before:raw.slice(start,end),after}]},{compile:async p=>(captured=p.source,pdf),outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
  assert.equal(checkedText,expected); assert.ok(captured.includes(typstString(expected)),raw); assert.deepEqual(d,original); assert.equal(out.verification.contentVerified, !out.verification.ambiguousBoundaries.length);
 }
});

test('signed numeric boundaries preserve independent literal expectations',async()=>{
 for(const [raw,cut,expected] of [['−12',1,'−12'],['-12',1,'-12'],['hard-repeat',5,'hard-repeat'],['helloWorld',5,'hello World']]){
  const d=make();d.blocks=[{id:'x',text:raw,source:{pageIndex:0,range:{start:0,end:raw.length},lines:[{range:{start:0,end:cut}},{range:{start:cut,end:raw.length}}]}}];
  let checkedText;
  await composeDocument({document:d,sourceBytes:src},{compile:async ({source})=>{assert.ok(source.includes(typstString(expected)));return pdf},outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
  assert.equal(checkedText,expected);
 }
});

test('Buffer snapshots own source, compiler result and checker bytes',async()=>{
 const input=Buffer.from(src), bytes=Buffer.from(pdf), inputOriginal=Buffer.from(input), bytesOriginal=Buffer.from(bytes), d=make(); let release, checkedSnapshot;
 const gate=new Promise(r=>release=r);
 const pending=composeDocument({document:d,sourceBytes:input},{fonts:{hasGlyph:async()=>{await gate;return true}},compile:async()=>bytes,outputCheck:async ({bytes:checked})=>{checkedSnapshot=new Uint8Array(checked);checked.fill(1);bytes.fill(2);return {checks:{content:{status:'pass'}},findings:[]}}});
 input.fill(3);release(); const out=await pending;
 assert.deepEqual(checkedSnapshot,new Uint8Array(bytesOriginal)); assert.equal(out.verification.sourceSha256,sha(inputOriginal)); assert.equal(out.sha256,sha(bytesOriginal));
 const fileBytes=new Uint8Array(await out.file.arrayBuffer());assert.deepEqual(fileBytes,new Uint8Array(bytesOriginal));assert.equal(sha(fileBytes),out.sha256);
 assert.deepEqual(input,Buffer.alloc(input.length,3));assert.deepEqual(bytes,Buffer.alloc(bytes.length,2));
});

test('worker settles and cleans handlers on each completion path',async()=>{
 for(const mode of ['throw','messageerror','error','success','abort']){
  const c=new AbortController();let terminated=0, removes=0;const originalRemove=c.signal.removeEventListener.bind(c.signal);c.signal.removeEventListener=(...args)=>{removes++;return originalRemove(...args)};
  const w={terminate(){terminated++},postMessage(){if(mode==='throw')throw new DOMException('clone error','DataCloneError');if(mode==='messageerror')this.onmessageerror({});if(mode==='error')this.onerror({message:'failed'});if(mode==='success')this.onmessage({data:{bytes:pdf}});if(mode==='abort')c.abort()}};
  const pending=compileInWorker(w,{},c.signal);
  if(mode==='success') assert.equal(await pending,pdf);else await assert.rejects(pending);
  c.abort();assert.equal(terminated,1,mode);assert.equal(removes,1,mode);assert.equal(w.onmessage,null);assert.equal(w.onerror,null);assert.equal(w.onmessageerror,null);
 }
});

test('ambiguous line break cannot claim content verification from a guessed separator',async()=>{
 const d=make();d.blocks=[{id:'x',text:'helloworld',source:{pageIndex:0,range:{start:0,end:10},lines:[{range:{start:0,end:5}},{range:{start:5,end:10}}]}}];
 let checkedText;
 const out=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf,outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
 assert.equal(checkedText,'hello world');assert.equal(out.verification.contentVerified,false);assert.equal(out.verification.outputTextCheck,'pass');assert.deepEqual(out.verification.ambiguousBoundaries,[{blockId:'x',offset:5}]);
});

test('ordered flow carries mixed styles, long edit and image bytes without mutating inputs',async()=>{
 const d=make();d.styles=[{id:'small',size:9},{id:'large',size:18}];d.blocks[0].source.characters=[{start:0,end:6,styleId:'large'},{start:6,end:26,styleId:'small'}];
 const long='After −12 [1] '.repeat(1000); const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,...Array(21).fill(0),73,69,78,68,174,66,96,130]);
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{kind:'heading',columns:1,span:'page',blockIds:['a']},{kind:'asset',columns:2,assetIds:['pic']},{kind:'caption',columns:2,blockIds:['b']}]};
 const assets=[{id:'pic',content:{representation:'png',bytes:png}}]; const snapshot=structuredClone({d,flow,assets});let payload;
 await composeDocument({document:d,sourceBytes:src,flow,assets,edits:[{...edit,after:long}]},{compile:async p=>(payload=p,pdf)});
 assert.ok(payload.source.indexOf('18pt')<payload.source.indexOf('#image('));assert.ok(payload.source.indexOf('#image(')<payload.source.indexOf(typstString(long)));assert.deepEqual(payload.files['assets/0.png'],png);assert.deepEqual({d,flow,assets},snapshot);
});

test('font coverage ignores layout controls',async()=>{const {inspectFonts}=await import('../src/paper-fonts.mjs');const result=await inspectFonts('a\t\n\r',{hasGlyph:cp=>cp===97});assert.equal(result.status,'covered');});


test('flow order, linked caption and artwork ownership set the checker expectation',async()=>{
 const d=make(); d.blocks.push({id:'inside',text:'panel',source:{pageIndex:0,range:{start:32,end:37},lines:[]}});
 const f={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{kind:'paragraph',blockIds:['b']},{kind:'asset',assetIds:['pic'],blockIds:['inside'],captionIds:['a']},{kind:'caption',blockIds:['a']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"></svg>'); let checked, payload;
 const out=await composeDocument({document:d,sourceBytes:src,flow:f,assets:[{id:'pic',content:{representation:'svg',bytes:svg}}]},{compile:async p=>(payload=p,pdf),outputCheck:async x=>(checked=x.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.deepEqual(checked.map(x=>x.id),['b','a']); assert.deepEqual(out.verification.artworkBlocks.map(x=>x.id),['inside']); assert.equal(out.verification.contentVerified,false); assert.match(payload.source,/#block\(sticky: true\)\[\#box\[.*#image\(/); assert.equal(payload.source.split('repeat hard-repeat').length-1,1);
});

test('tall source artwork fits page height with a separate flowing caption',async()=>{
 const d=make(), source={pageIndex:0,bbox:[0,0,200,1000]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{kind:'asset',span:'page',assetIds:['pic'],blockIds:[],captionIds:['a'],source},{kind:'caption',blockIds:['a']},{kind:'paragraph',blockIds:['b']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="1000"></svg>');let generated;
 await composeDocument({document:d,sourceBytes:src,flow,assets:[{id:'pic',source,content:{representation:'svg',bytes:svg}}]},{compile:async p=>(generated=p.source,pdf)});
 assert.match(generated,/#block\(sticky: true\)\[.*#image\("assets\/0.svg", width: 101.6pt\)/);
 assert.ok(generated.indexOf('#text("repeat hard-repeat')>generated.indexOf('width: 101.6pt)'));
});

test('sparse last column before a full-width figure does not force a column break',async()=>{
 const d=make(); d.blocks=Array.from({length:4},(_,i)=>({id:`p${i}`,text:`Paragraph ${i}`,source:{pageIndex:0,range:{start:i*20,end:i*20+11},lines:[]}}));
 const box=[0,0,100,100], svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[...d.blocks.map(b=>({kind:'paragraph',columns:2,blockIds:[b.id]})),{kind:'asset',span:'page',assetIds:['pic'],blockIds:[],source:{pageIndex:0,bbox:box}}]};
 const spans=d.blocks.map((b,i)=>({id:b.id,sourcePage:0,start:{page:1,x:36,y:50+i*60},end:{page:1,x:36,y:100+i*60}}));
 for(const rightColumn of [false,true]) {
  let sources=[], expected;const mapped=structuredClone(spans);if(rightColumn) mapped[3].start.x=250;
  await composeDocument({document:d,sourceBytes:src,flow,assets:[{id:'pic',source:{pageIndex:0,bbox:box},content:{representation:'svg',bytes:svg}}]},{compile:async p=>(sources.push(p.source),{bytes:pdf,blockSpans:mapped}),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.equal(sources.length,1);assert.equal(sources.at(-1).includes('#colbreak()'),false);assert.deepEqual(expected.map(x=>x.text),d.blocks.map(x=>x.text));
 }
});

test('spanning paragraphs do not trigger a synthetic column break',async()=>{
 const d=make();d.blocks=Array.from({length:3},(_,i)=>({id:`p${i}`,text:`Paragraph ${i}`,source:{pageIndex:0,range:{start:i*20,end:i*20+11},lines:[]}}));
 const box=[0,0,100,100],svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[...d.blocks.map(b=>({kind:'paragraph',columns:2,blockIds:[b.id]})),{kind:'asset',span:'page',assetIds:['pic'],blockIds:[],source:{pageIndex:0,bbox:box}}]};
 for(const bottom of [404,406,500,565]) {
  const spans=[{id:'p0',sourcePage:0,start:{page:1,x:36,y:300},end:{page:2,x:36,y:60}},{id:'p1',sourcePage:0,start:{page:2,x:36,y:60},end:{page:2,x:36,y:250}},{id:'p2',sourcePage:0,start:{page:2,x:36,y:250},end:{page:2,x:36,y:bottom}}];let sources=[],checked;
  await composeDocument({document:d,sourceBytes:src,flow,assets:[{id:'pic',source:{pageIndex:0,bbox:box},content:{representation:'svg',bytes:svg}}]},{compile:async p=>(sources.push(p.source),{bytes:pdf,blockSpans:spans}),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.equal(sources.length,1,`bottom ${bottom}`);assert.equal(sources.at(-1).includes('#colbreak()'),false);assert.deepEqual(checked.map(x=>x.text),d.blocks.map(x=>x.text));
 }
});

test('union capture owns panels and rejects missing or malformed occurrences',async()=>{
 const d=make(), source={pageIndex:0,bbox:[0,0,20,10]}; d.assets=[{id:'p1'},{id:'p2'}];
 const f={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{kind:'asset',assetIds:['p1','p2'],blockIds:[],renderAssetId:'union',source},{kind:'paragraph',blockIds:['a','b']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"></svg>'); let payload;
 const asset={id:'union',source:{...source,assetIds:['p1','p2'],blockIds:[]},content:{representation:'svg',bytes:svg}};
 let out=await composeDocument({document:d,sourceBytes:src,flow:f,assets:{sourceSha256:d.sourceSha256,assets:[asset]}},{compile:async p=>(payload=p,pdf)}); assert.equal(out.verification.assetFindings.length,0); assert.equal(Object.keys(payload.files).length,1);
 asset.content.bytes=new TextEncoder().encode('not svg'); out=await composeDocument({document:d,sourceBytes:src,flow:f,assets:{sourceSha256:d.sourceSha256,assets:[asset]}},{compile:async()=>pdf}); assert.equal(out.verification.assetFindings[0].code,'asset-invalid-format'); assert.equal(out.verification.contentVerified,false);
});

test('fragment crossing edit and inline joiners preserve exact output sequence',async()=>{
 const d=make(), parent=d.blocks[1], a={...structuredClone(parent),id:'b1',parentBlockId:'b',text:'rep',source:{pageIndex:0,range:{start:26,end:29},lines:[]}}, b={...structuredClone(parent),id:'b2',parentBlockId:'b',text:'eat',source:{pageIndex:0,range:{start:29,end:32},lines:[]}};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,fragments:[a,b],items:[{kind:'paragraph',blockIds:['a']},{kind:'paragraph',inline:true,blockIds:['b1','b2'],joiners:['']}]}; let expected, source;
 await composeDocument({document:d,sourceBytes:src,flow,edits:[{...edit,start:27,end:31,before:'epea',after:'X'}]},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(expected[1].text,'rXt'); assert.ok(source.includes(typstString('rX'))); assert.ok(source.includes(typstString('t')));
});

test('inline joiners retain their original positions when fragments are deleted',async()=>{
 for(const [start,end,after,expected,rendered] of [
  [1,2,'','a-+c','#text("a")#text("-")#text("+")'],
  [0,1,'','-b+c','#text("-")'],
  [2,3,'','a-b+','#text("+")'],
  [0,3,'','-+','#text("-")#text("+")'],
  [0,2,'X −12','X −12-+c','#text("X −12")#text("-")#text("+")'],
 ]) {
  const d=make();d.blocks=[{id:'p',text:'abc',source:{pageIndex:0,range:{start:0,end:3},lines:[]}}];
  const fragments=['a','b','c'].map((text,i)=>({id:`f${i}`,parentBlockId:'p',text,source:{pageIndex:0,range:{start:i,end:i+1},lines:[]}}));
  const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,fragments,items:[{kind:'paragraph',inline:true,blockIds:fragments.map(f=>f.id),joiners:['-','+']}]};
  let source,checked;
  await composeDocument({document:d,sourceBytes:src,flow,edits:[{blockId:'p',pageIndex:0,start,end,before:'abc'.slice(start,end),after}]},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.equal(checked[0].text,expected);assert.ok(source.replace(/#context \[.*?#label\("paper-block(?:-end)?"\)\]/g,'').includes(rendered),source);
  const literalText=[...source.matchAll(/#text\("([^"\\]*)"\)/g)].map(m=>m[1]).join('');
  assert.equal(literalText,expected);
 }
});

test('200000-character styled replacement appears literally in generated source',async()=>{
 const d=make();d.blocks=[{id:'p',text:'repeat',source:{pageIndex:0,range:{start:0,end:6},lines:[],characters:[{start:0,end:6,styleId:'s'}]}}];d.styles=[{id:'s',size:10}];
 const after='a'.repeat(200000);let source,checked;
 await composeDocument({document:d,sourceBytes:src,edits:[{blockId:'p',pageIndex:0,start:0,end:6,before:'repeat',after}]},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(checked[0].text,after);assert.ok(source.includes(`#text(size: 10pt, "${after}")`));
});
import {createTypstCompile} from '../src/paper-typst.mjs';
test('Typst owned world, compiler and font resources are released on success and failure',async()=>{
 for(const mode of ['success','compile-error','abort']) {
  const freed=[], controller=new AbortController();
  const world={get_artifact(){if(mode==='abort')controller.abort(); if(mode==='compile-error')throw Error('failure'); return {result:pdf}},query(){return JSON.stringify([{id:'a',page:1,x:36,y:36}])},free(){freed.push('world')}};
  const compiler={init:async()=>{compiler.compiler={snapshot:()=>world,free:()=>freed.push('compiler')}},setFonts(){},addSource(){},mapShadow(){},resetShadow(){freed.push('shadow')}};
  const builder={init:async()=>{builder.fontBuilder={build:async()=>({free:()=>freed.push('resolver')}),free:()=>freed.push('builder')}},addFontData:async()=>{}};
  const compile=createTypstCompile({createTypstCompiler:()=>compiler,createTypstFontBuilder:()=>builder,loadFonts:()=>()=>{}});
  if(mode==='success') {const result=await compile({source:'x'});assert.equal(result.blockMap[0].id,'a');} else await assert.rejects(compile({source:'x',signal:controller.signal}));
  assert.deepEqual(freed,['world','shadow','compiler','resolver']);
 }
});

test('Typst build rejection leaves the moved builder to the build operation',async()=>{
 const freed=[];let moved=false;
 const compiler={init:async()=>{compiler.compiler={free:()=>freed.push('compiler')}},resetShadow(){freed.push('shadow')}};
 const builder={init:async()=>{builder.fontBuilder={build(){moved=true;return Promise.reject(Error('build failed'))},free(){assert.equal(moved,false);freed.push('builder')}}}};
 const compile=createTypstCompile({createTypstCompiler:()=>compiler,createTypstFontBuilder:()=>builder,loadFonts:()=>()=>{}});
 await assert.rejects(compile({source:'x'}),/build failed/);assert.equal(moved,true);assert.deepEqual(freed,['shadow','compiler']);
});

test('source spacing survives styles, fragments, joiners and edits without changing offsets',async()=>{
 for(const [start,end,after,joiner,expected] of [[null,null,'','','hello world'],[null,null,'',' ','hello world'],[3,7,'X','','helXrld'],[5,10,'earth','','hello earth'],[0,5,'hi','','hi world'],[3,7,'😀 long  After','','hel😀 long  Afterrld']]) {
  const d=make();d.styles=[{id:'a',size:10},{id:'b',size:12}];d.blocks=[{id:'p',text:'helloworld',source:{pageIndex:0,range:{start:10,end:20},lines:[],wordSpaceOffsets:[15],characters:[{start:10,end:15,styleId:'a'},{start:15,end:20,styleId:'b'}]}}];
  const fragments=[{id:'f1',parentBlockId:'p',text:'hello',source:{pageIndex:0,range:{start:10,end:15},lines:[],characters:[{start:10,end:15,styleId:'a'}]}},{id:'f2',parentBlockId:'p',text:'world',source:{pageIndex:0,range:{start:15,end:20},lines:[],characters:[{start:15,end:20,styleId:'b'}]}}];
  const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,fragments,items:[{kind:'paragraph',inline:true,blockIds:['f1','f2'],joiners:[joiner]}]};const snapshot=structuredClone({d,flow});let source,checked;
  const edits=start===null?[]:[{blockId:'p',pageIndex:0,start:start+10,end:end+10,before:'helloworld'.slice(start,end),after}];
  await composeDocument({document:d,sourceBytes:src,flow,edits},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.equal(checked[0].text,expected); const rendered=[...source.matchAll(/#text\((?:size: \d+pt, )?"([^"\\]*)"\)/g)].map(m=>m[1]).join('');assert.equal(rendered,expected);assert.deepEqual({d,flow},snapshot);
 }
});

// Minimal planner fixture; the source-furniture worker supplies production classification.
function fixturePlanner({document,flow,editedBlockIds}) {
 const pages=document.pages.map(p=>({sourcePage:p.sourcePageIndex,header:[],footer:[]})), excludedBlockIds=[],excludedItemIds=[];
 for(const item of flow.items.filter(i=>['header','footer'].includes(i.kind))) {
  const b=document.blocks.find(b=>b.id===item.blockIds?.[0]); if(!b || editedBlockIds.includes(b.id)) continue;
  const pg=pages.find(p=>p.sourcePage===item.source.pageIndex); if(!pg) continue;
  pg[item.kind].push({kind:'text',itemId:item.id,blockId:b.id,bbox:item.source.bbox,source:b.source,text:b.text}); excludedBlockIds.push(b.id);excludedItemIds.push(item.id);
 }
 return {sourceSha256:document.sourceSha256,margins:{top:60,right:36,bottom:36,left:36},pages,excludedBlockIds,excludedItemIds,diagnostics:[]};
}
test('running furniture keeps source occurrences separate from body expectations',async()=>{
 const d=make();d.pages=[{sourcePageIndex:0,width:600,height:800},{sourcePageIndex:1,width:600,height:800}];
 const header=(id,page)=>({id,text:'Journal',source:{pageIndex:page,bbox:[40,10,90,20],range:{start:0,end:7},lines:[]}});
 d.blocks=[header('h0',0),{id:'body0',text:'Body one',source:{pageIndex:0,range:{start:10,end:18},lines:[]}},header('h1',1),{id:'body1',text:'Body two',source:{pageIndex:1,range:{start:10,end:18},lines:[]}}];
 const f={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:d.blocks.map(b=>({id:'i'+b.id,kind:b.id.startsWith('h')?'header':'paragraph',blockIds:[b.id],source:{pageIndex:b.source.pageIndex,bbox:b.source.bbox},columns:b.id.startsWith('h')?1:2,span:b.id.startsWith('h')?'page':'column'}))};
 let source,checked;
 const run=edits=>composeDocument({document:d,sourceBytes:src,flow:f,edits,runningFurniture:true},{furniturePlanner:fixturePlanner,compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 let out=await run([]);assert.match(source,/#set page\(header-ascent: 0pt, header:/);assert.equal((source.match(/#columns\(2\)/g)||[]).length,1);assert.deepEqual(checked.expectedBlocks.map(b=>b.id),['body0','body1']);assert.equal(checked.expectedFurniture.length,2);assert.deepEqual(checked.expectedFurniture.map(t=>t.sourcePage),[0,1]);assert.equal(out.verification.contentVerified,false);
 out=await run([{blockId:'h1',pageIndex:1,start:0,end:7,before:'Journal',after:'Changed'}]);assert.equal(out.verification.furniture.templates.length,1);assert.deepEqual(checked.expectedBlocks.map(b=>b.id),['body0','h1','body1']);assert.ok(source.includes('Changed'));
 d.blocks[2].text='Another';out=await run([]);assert.equal(out.verification.furniture.templates.length,2);assert.equal(checked.expectedBlocks.length,2);assert.ok(source.includes('Another'));
});

test('separately placed furniture does not inherit a parent fragment separator',async()=>{
 const d=make(); d.pages=[{sourcePageIndex:0,width:600,height:800}];
 d.blocks=[{id:'p',text:'Journalhttps://doi.org/x',source:{pageIndex:0,range:{start:0,end:24},lines:[{range:{start:0,end:7}},{range:{start:7,end:24}}]}}];
 const fragments=[{id:'body',parentBlockId:'p',text:'Journal',source:{pageIndex:0,range:{start:0,end:7},lines:[]}},{id:'doi',parentBlockId:'p',text:'https://doi.org/x',source:{pageIndex:0,range:{start:7,end:24},lines:[],bbox:[390,10,500,20]}}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,fragments,items:[{id:'body-item',kind:'paragraph',blockIds:['body']},{id:'doi-item',kind:'header',blockIds:['doi'],source:{pageIndex:0,bbox:[390,10,500,20]}}]};
 const planner=()=>({sourceSha256:d.sourceSha256,margins:{top:60,right:36,bottom:36,left:36},pages:[{sourcePage:0,header:[{kind:'text',itemId:'doi-item',blockId:'doi',bbox:[390,10,500,20],source:fragments[1].source,text:fragments[1].text}],footer:[]}],excludedBlockIds:['doi'],excludedItemIds:['doi-item'],diagnostics:[]});
 let source,checked; await composeDocument({document:d,sourceBytes:src,flow,runningFurniture:true},{furniturePlanner:planner,compile:async p=>(source=p.source,pdf),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(checked.expectedFurniture[0].text,'https://doi.org/x'); assert.match(source,/#text\("https:\/\/doi\.org\/x"\)/);
});

test('first block carries a source marker in default and flow layouts',async()=>{
 const d=make();
 for(const flow of [undefined,{schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:d.blocks.map(b=>({kind:'paragraph',blockIds:[b.id],columns:2}))}]) {
  let source;
  await composeDocument({document:d,sourceBytes:src,flow,runningFurniture:!!flow},{furniturePlanner:fixturePlanner,compile:async p=>(source=p.source,pdf)});
  assert.match(source,/#metadata\(\(id: "a",/);
  assert.match(source,/#metadata\(\(id: "b",/);
 }
});

test('source page furniture variants and gaps preserve provenance and asset markers',async()=>{
 const d=make();d.pages=[0,1,2].map(sourcePageIndex=>({sourcePageIndex,width:400,height:600}));
 const h=(id,page,text)=>({id,text,source:{pageIndex:page,bbox:[40,10,120,20],range:{start:0,end:text.length},lines:[]}});
 d.blocks=[h('titlehead',0,'Title'),{...d.blocks[0],id:'body0'},h('normal',1,'Journal'),{...d.blocks[1],id:'body1',source:{...d.blocks[1].source,pageIndex:1}},{...d.blocks[1],id:'body2',source:{...d.blocks[1].source,pageIndex:2}}];
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'h0',kind:'header',source:{pageIndex:0,bbox:[40,10,120,20]},blockIds:['titlehead']},{kind:'paragraph',blockIds:['body0'],columns:2},{id:'h1',kind:'header',source:{pageIndex:1,bbox:[40,10,120,20]},blockIds:['normal']},{kind:'asset',source:{pageIndex:1,bbox:[0,0,10,10]},assetIds:['pic'],columns:2},{kind:'paragraph',blockIds:['body1'],columns:2},{kind:'paragraph',blockIds:['body2'],columns:2}]};
 let source,checked;const result=await composeDocument({document:d,sourceBytes:src,flow,runningFurniture:true,assets:[{id:'pic',source:{pageIndex:1,bbox:[0,0,10,10]},content:{representation:'svg',bytes:svg}}]},{furniturePlanner:fixturePlanner,compile:async p=>(source=p.source,{bytes:pdf,furnitureMap:[{id:'normal',sourcePage:1,page:2,x:40,y:10}]}),outputCheck:async p=>(checked=p,{checks:{content:{status:'unavailable'}},findings:[]})});
 assert.deepEqual(checked.expectedBlocks.map(x=>x.id),['body0','body1','body2']);assert.deepEqual(checked.expectedFurniture.map(x=>x.sourcePage),[0,1]);assert.match(source,/if sp == 0/);assert.match(source,/else if sp == 1/);assert.doesNotMatch(source,/if sp == 2/);assert.match(source,/#metadata\(\(id: "pic",[^\n]*sourcePage: 1/);assert.equal(result.verification.furniture.output[0].page,2);
});


test('start and end queries preserve spanning blocks and asset positions',async()=>{
 const values={'<paper-block>':[{id:'old',sourcePage:0,page:1,x:36,y:50},{id:'new',sourcePage:1,page:2,x:36,y:300},{id:'pic',sourcePage:2,page:3,x:36,y:36}],'<paper-block-end>':[{id:'old',sourcePage:0,page:2,x:36,y:200},{id:'new',sourcePage:1,page:2,x:36,y:400},{id:'pic',sourcePage:2,page:3,x:136,y:136}],'<paper-furniture>':[]};
 const world={get_artifact:()=>({result:pdf}),query:(_a,label)=>JSON.stringify(values[label]),free(){}};
 const compiler={init:async()=>{compiler.compiler={snapshot:()=>world,free(){}}},setFonts(){},addSource(){},mapShadow(){},resetShadow(){}};
 const builder={init:async()=>{builder.fontBuilder={build:async()=>({free(){}})}}};
 const compile=createTypstCompile({createTypstCompiler:()=>compiler,createTypstFontBuilder:()=>builder,loadFonts:()=>()=>{}});
 const result=await compile({source:'x'});
 assert.equal(result.blockMap[0].id,'old'); assert.deepEqual(result.blockSpans.map(s=>[s.id,s.sourcePage,s.start.page,s.end.page]),[['old',0,1,2],['new',1,2,2],['pic',2,3,3]]);
});

test('glyph lookup rejection is observed before asynchronous source hashing',async()=>{
 const d=make(); const unhandled=[]; const listener=e=>unhandled.push(e); process.on('unhandledRejection',listener);
 try { const result=await composeDocument({document:d,sourceBytes:src},{fonts:{hasGlyph:()=>Promise.reject(Error('unavailable'))},compile:async()=>pdf}); await new Promise(resolve=>setImmediate(resolve)); assert.equal(unhandled.length,0); assert.equal(result.verification.coverage.status,'unavailable'); assert.ok(result.file); } finally {process.off('unhandledRejection',listener);}
});


test('reserved furniture boxes use planned margins and output counters',async()=>{
 const d=make();d.blocks=[{id:'h',text:'Header',source:{pageIndex:0,bbox:[40,45,100,55],range:{start:0,end:6},lines:[]}},{id:'count',text:'1 / 1',source:{pageIndex:0,bbox:[50,550,80,560],range:{start:0,end:5},lines:[]}},{id:'body',text:'body',source:{pageIndex:0,range:{start:0,end:4},lines:[]}}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:d.blocks.map(b=>({id:'i'+b.id,kind:'paragraph',blockIds:[b.id],source:b.source}))};
 const planner=()=>({sourceSha256:d.sourceSha256,margins:{top:80,right:40,bottom:70,left:30},pages:[{sourcePage:0,header:[{kind:'text',itemId:'ih',blockId:'h',source:d.blocks[0].source,bbox:d.blocks[0].source.bbox,text:'Header'}],footer:[{kind:'counter',itemId:'icount',blockId:'count',source:d.blocks[1].source,bbox:d.blocks[1].source.bbox,text:'1 / 1'}]}],excludedItemIds:['ih','icount'],excludedBlockIds:['h','count'],diagnostics:[]});
 let source,check;const out=await composeDocument({document:d,sourceBytes:src,flow,runningFurniture:true},{furniturePlanner:planner,compile:async p=>(source=p.source,pdf),outputCheck:async p=>(check=p,{checks:{content:{status:'unavailable'}},findings:[]})});
 assert.match(source,/margin: \(top: 80pt, right: 40pt, bottom: 70pt, left: 30pt\)/);assert.match(source,/header-ascent: 0pt/);assert.match(source,/footer-descent: 0pt/);assert.match(source,/box\(height: 80pt\)/);assert.match(source,/counter\(page\)\.display\("1 \/ 1", both: true\)/);assert.match(source,/s.value.page <= p and e.value.page >= p/);assert.deepEqual(check.expectedBlocks.map(x=>x.id),['body']);assert.equal(out.verification.furniture.templates[1].text,'1 / 1');
});

test('link plan is rendered at source offsets and edits inherit only covered destinations',async()=>{
 const d=make(); const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'one',kind:'paragraph',source:{pageIndex:0},blockIds:['a']},{id:'two',kind:'paragraph',source:{pageIndex:0},blockIds:['b']}]};
 const external=(id,start,end,uri)=>({id,external:true,uri,source:{pageIndex:0},relation:{ranges:[{blockId:'a',start,end}],assetIds:[]}});
 const links={sourceSha256:d.sourceSha256,links:[external('one',0,6,'https://example.org'),external('dup',0,6,'https://example.org'),external('doi',12,18,'https://doi.org/10.1/x')]};
 const edit={blockId:'a',pageIndex:0,start:1,end:4,before:'epe',after:'NEW'}; const copy=structuredClone({d,flow,links,edit});let source;
 const out=await composeDocument({document:d,sourceBytes:src,flow,links,edits:[edit]},{compile:async x=>(source=x.source,pdf)});
 assert.ok(source.includes('#link("https://example.org")')); assert.ok(source.includes('#link("https://doi.org/10.1/x")')); assert.ok(source.includes('NEW')); assert.deepEqual(out.linkPlan.sourceRuns[0].linkIds,['one','dup']); assert.deepEqual({d,flow,links,edit},copy);
});

test('internal link emits a typed target and deleted target stays unresolved',async()=>{
 const d=make();const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'one',kind:'paragraph',source:{pageIndex:0},blockIds:['a']},{id:'two',kind:'paragraph',source:{pageIndex:0},blockIds:['b']}]};
 const links={sourceSha256:d.sourceSha256,links:[{id:'inside',uri:'#page=1',external:false,source:{pageIndex:0},relation:{ranges:[{blockId:'a',start:0,end:6}],assetIds:[]},target:{status:'resolved',pageIndex:0,relation:{status:'text',blockId:'b',start:26,end:27}}}]};
 let source;const compile=async x=>(source=x.source,pdf);let out=await composeDocument({document:d,sourceBytes:src,flow,links},{compile});assert.match(source,/#link\(label\("link-target-/); assert.match(source,/#box\[\]#label\("link-target-/);assert.equal(out.linkPlan.targets.length,1);
 out=await composeDocument({document:d,sourceBytes:src,flow,links,edits:[{...edit,after:''}]},{compile});assert.ok(!source.includes('#link('));assert.equal(out.linkPlan.targets[0].status,'deleted');
});

test('linked asset and target use item ownership, conflicts do not select a destination',async()=>{
 const d=make();d.assets=[{id:'pic',source:{pageIndex:0,bbox:[0,0,10,10]}}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'one',kind:'paragraph',source:{pageIndex:0},blockIds:['a']},{id:'img',kind:'asset',source:{pageIndex:0,bbox:[0,0,10,10]},assetIds:['pic']},{id:'two',kind:'paragraph',source:{pageIndex:0},blockIds:['b']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
 const assets=[{id:'pic',source:{pageIndex:0,bbox:[0,0,10,10]},content:{representation:'svg',bytes:svg}}];
 const links={sourceSha256:d.sourceSha256,links:[{id:'pic-link',external:true,uri:'https://image.example',source:{pageIndex:0},relation:{ranges:[],assetIds:['pic']}},{id:'internal',external:false,uri:'#old',source:{pageIndex:0},relation:{ranges:[{blockId:'a',start:0,end:6}],assetIds:[]},target:{status:'resolved',pageIndex:0,relation:{status:'asset',assetId:'pic'}}}]};let source;
 const out=await composeDocument({document:d,sourceBytes:src,flow,assets,links},{compile:async x=>(source=x.source,pdf)});assert.match(source,/#link\("https:\/\/image.example"\)\[#image/);assert.ok(out.linkPlan.targets.some(t=>t.assetItemId==='img'));assert.match(source,/#box\[\]#label\("link-target-/);
});

test('conflicting text annotations preserve non-overlapping portions',async()=>{
 const d=make(),flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{id:'one',kind:'paragraph',source:{pageIndex:0},blockIds:['a']},{id:'two',kind:'paragraph',source:{pageIndex:0},blockIds:['b']}]};
 const l=(id,start,end,uri)=>({id,uri,external:true,source:{pageIndex:0},relation:{ranges:[{blockId:'a',start,end}],assetIds:[]}});const links={sourceSha256:d.sourceSha256,links:[l('a',0,6,'https://a'),l('b',3,9,'https://b')]};let source;const out=await composeDocument({document:d,flow,links,sourceBytes:src},{compile:async p=>(source=p.source,pdf)});assert.match(source,/#link\("https:\/\/a"\)\[#text\("rep"\)\]/);assert.match(source,/#text\("eat"\)/);assert.match(source,/#link\("https:\/\/b"\)/);assert.ok(out.linkPlan.diagnostics.some(d=>d.code==='source-link-conflict'));
});

test('running furniture retains external annotations without emitting repeated labels',async()=>{
 const d=make();d.pages=[{sourcePageIndex:0,width:600,height:800},{sourcePageIndex:1,width:600,height:800}];const h=(id,page)=>({id,text:'Journal',source:{pageIndex:page,bbox:[40,10,90,20],range:{start:0,end:7},lines:[]}});d.blocks=[h('h0',0),{id:'b0',text:'Body',source:{pageIndex:0,range:{start:10,end:14},lines:[]}},h('h1',1),{id:'b1',text:'Body',source:{pageIndex:1,range:{start:10,end:14},lines:[]}}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:d.blocks.map(b=>({id:'i'+b.id,kind:b.id.startsWith('h')?'header':'paragraph',blockIds:[b.id],source:{pageIndex:b.source.pageIndex,bbox:b.source.bbox},columns:1,span:'page'}))};
 const links={sourceSha256:d.sourceSha256,links:[{id:'h',uri:'https://journal.example',external:true,source:{pageIndex:0},relation:{ranges:[{blockId:'h0',start:0,end:7}],assetIds:[]}},{id:'target',uri:'#old',external:false,source:{pageIndex:1},relation:{ranges:[{blockId:'b1',start:10,end:14}],assetIds:[]},target:{status:'resolved',pageIndex:0,relation:{status:'text',blockId:'h0',start:0,end:1}}}]};let source;const out=await composeDocument({document:d,sourceBytes:src,flow,links,runningFurniture:true},{furniturePlanner:fixturePlanner,compile:async x=>(source=x.source,pdf)});assert.match(source,/#link\("https:\/\/journal.example"\)/);assert.doesNotMatch(source,/#label\("link-target-/);assert.ok(out.linkPlan.diagnostics.some(x=>x.code==='target-furniture-unresolved'));
});
