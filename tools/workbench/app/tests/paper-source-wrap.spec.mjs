import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDocument} from '../src/paper-document.mjs';
import {findSourceWrapOmissions,sourceWrapOffsetsForBlock} from '../src/paper-source-wrap.mjs';
import {composeDocument} from '../src/paper-compose.mjs';
import {createHash,webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;

function model(lines, other=['similar']) {
  let y=10;
  function block(parts) {const chars=[], ranges=[]; const top=y;
    for(const text of parts) {const start=chars.length; let x=10; for(const c of text) {chars.push({text:c,bbox:[x,y,x+1,y+1]});x++;} ranges.push({start,end:chars.length,bbox:[10,y,x,y+1],direction:[1,0],writingMode:0,baseline:[[10,y+0.8],[x-1,y+0.8]]}); y+=3;}
    return {bbox:[10,top,100,y],chars,lines:ranges};}
  return normalizeDocument({sourceSha256:'a'.repeat(64),pages:[{width:200,height:300,geometry:{frame:'mupdf-display',pageTransform:[1,0,0,-1,0,300]},blocks:[block(lines),...other.map(x=>block([x]))],images:[]}]});
}
const run=d=>findSourceWrapOmissions({document:d}).omissions;
test('source-located omission and fragment mapping preserve input',()=>{const d=model(['simi-','lar text']); const before=structuredClone(d), [o]=run(d), b=d.blocks[0]; assert.deepEqual(d,before); assert.equal(o.start,4); assert.equal(o.end,5); assert.equal(o.evidence.joined,'similar'); assert.equal(o.evidence.corroboration.length,1); assert.deepEqual(sourceWrapOffsetsForBlock(b,[o]),[4]); const f={...b,id:'existing-fragment',parentBlockId:b.id,text:b.text.slice(2,6),source:{...b.source,range:{start:2,end:6}}}; assert.deepEqual(sourceWrapOffsetsForBlock(f,[o]),[2]);});
test('real compounds, ambiguous corroboration, scientific tokens and missing corroboration stay literal',()=>{for(const [parts,other] of [[['two-','step'],['twostep','two-step']],[['simi-','lar'],['similar','simi-lar']],[['gene2-','alpha'],['gene2alpha']],[['αsimi-','lar'],['similar']],[['ABC-','def'],['ABCdef']],[['simi−','lar'],['similar']],[['simi-','lar'],['unrelated']]]) assert.equal(run(model(parts,other)).length,0,JSON.stringify(parts));});
test('explicit spaces and recovered spacing prevent joining',()=>{for(const parts of [['simi- ','lar'],['simi-',' lar']]) assert.equal(run(model(parts)).length,0); const d=model(['simi-','lar']);d.blocks[0].source.wordSpaceOffsets=[5];assert.equal(run(d).length,0);});
test('unsupported geometry, incomplete characters, source frames and stale hashes fail closed',()=>{for(const change of [d=>d.blocks[0].source.lines[0].direction=[0,1],d=>d.blocks[0].source.lines[1].baseline=null,d=>d.blocks[0].source.characters[0].bbox=null,d=>d.pages[0].geometry.frame='unknown',d=>d.pages[0].geometry.pageTransform=[0,1,1,0,0,0],d=>d.pages[0].text='wrong',d=>d.blocks[0].source.lines[1].range.start++]) {const d=model(['simi-','lar']);change(d);assert.equal(run(d).length,0);} assert.throws(()=>findSourceWrapOmissions({document:model(['simi-','lar']),bytes:new Uint8Array([1])}),{code:'stale-source'});});

test('ambiguous short prefixes, URLs and email labels stay literal',()=>{
 for(const [parts,other] of [[['re-','sign'],['resign']],[['https://host/simi-','lar'],['similar']],[['simi-','lar@example.org'],['similar']],[['simi-','lar'],['https://host/similar']]]) assert.equal(run(model(parts,other)).length,0);
 assert.equal(run(model(['data/simi-','lar'],['similar'])).length,0);
 const code=model(['simi-','lar'],['similar']);code.styles=[{id:'code',fontName:'Courier',size:10}];for(const c of code.blocks[0].source.characters)c.styleId='code';assert.equal(run(code).length,0);
});

test('composition projects only unchanged source words and preserves literal After',async()=>{
 const bytes=new TextEncoder().encode('source'), pdf=new TextEncoder().encode('%PDF-1.7\n');
 for(const edited of [false,true]) {
  const document=model(['simi-','lar text']);document.sourceSha256=createHash('sha256').update(bytes).digest('hex');const original=structuredClone(document);
  const b=document.blocks[0], edits=edited?[{blockId:b.id,pageIndex:0,start:0,end:8,before:'simi-lar',after:'typed-\nvalue'}]:[];
  let source,expected;
  const out=await composeDocument({document,sourceBytes:bytes,edits},{compile:async x=>(source=x.source,pdf),outputCheck:async x=>(expected=x.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
  assert.deepEqual(document,original);assert.equal(out.verification.sourceNormalization.lineWrapHyphens.length,edited?0:1);
  assert.equal(expected[0].text,edited?'typed-\nvalue text':'similar text');
  if(edited) {assert.match(source,/#text\("typed-"\)/);assert.match(source,/#linebreak\(\)/);}else {assert.match(source,/#text\("similar text"\)/);assert.doesNotMatch(source,/simi-lar text/);}
 }
});

test('words captured as artwork are not reported as text normalization',async()=>{
 const bytes=new TextEncoder().encode('source'), document=model(['simi-','lar text']);document.sourceSha256=createHash('sha256').update(bytes).digest('hex');
 const [art,body]=document.blocks, asset={id:'picture',source:{pageIndex:0,bbox:art.source.bbox},content:{representation:'svg',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')}};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:document.sourceSha256,items:[{kind:'asset',assetIds:['picture'],blockIds:[art.id],source:art.source},{kind:'paragraph',blockIds:[body.id]}]};
 const out=await composeDocument({document,sourceBytes:bytes,flow,assets:[asset]},{compile:async()=>new TextEncoder().encode('%PDF-1.7\n')});
 assert.deepEqual(out.verification.sourceNormalization.lineWrapHyphens,[]);
});
