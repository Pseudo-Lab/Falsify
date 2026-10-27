import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto;
const bytes=new TextEncoder().encode('source'), hash=createHash('sha256').update(bytes).digest('hex');
const block=(id,text,page,lines=1)=>({id,text,styleId:'body',source:{pageIndex:page,range:{start:0,end:text.length},lines:Array.from({length:lines},(_,i)=>({range:{start:Math.floor(i*text.length/lines),end:Math.floor((i+1)*text.length/lines)}}))}});
async function run(variant='positive',placement='page') {
 const long=block('long','L'.repeat(160),0), a=block('a','Alpha',0), b=block('b','Beta',0), cap=block('cap','Caption',0);
 const box=[40,330,180,350], capBox=[40,365,360,440], artBox=[40,40,360,500];
 const document={schema:'falsify.paper-document.v1',sourceSha256:hash,pages:[{width:400,height:600},{width:400,height:600}],styles:[{id:'body',size:10}],blocks:[long,a,b,cap],assets:[{id:'art',source:{pageIndex:1,bbox:artBox}}]};
 const item={id:'item',kind:'paragraph',columns:2,span:'column',source:{pageIndex:0,bbox:box},blockIds:['a','b'],inline:true,joiners:[' / ']};
 const caption={id:'caption',kind:'caption',source:{pageIndex:0,bbox:capBox},blockIds:['cap']};
 const asset={id:'asset',kind:'asset',columns:1,span:'page',source:{pageIndex:1,bbox:artBox},blockIds:[],assetIds:['art'],captionIds:['cap'],captionPositions:{cap:'above'}};
 const items=[{id:'long',kind:'paragraph',columns:2,span:'column',source:{pageIndex:0},blockIds:['long']},item,caption,asset];
 let edits=[];
 if(variant==='long') {a.source.lines=block('a','Alpha',0,4).source.lines;}
 if(variant==='heading') item.kind='heading';
 if(variant==='nonadjacent') items.splice(2,0,{id:'barrier',kind:'heading',source:{pageIndex:0},blockIds:[]});
 if(variant==='source-mismatch') item.source.pageIndex=1;
 if(variant==='edited-long') edits=[{blockId:'a',pageIndex:0,start:0,end:5,before:'Alpha',after:'X'.repeat(241)}];
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items};
 const assets=[{id:'art',source:{pageIndex:1,bbox:artBox},content:{representation:'svg',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="460"></svg>')}}];
 let source,expected;
 await composeDocument({document,sourceBytes:bytes,flow,assets,edits,layoutMode:'measured-continuous',figurePlacement:placement},{compile:async p=>(source=p.source,{bytes:new TextEncoder().encode('%PDF-1.7')}),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 return {source,expected};
}
test('keeps an entire source item, its joiner and styling before its caption and image',async()=>{
 const {source,expected}=await run(); const page=source.indexOf('#page(columns: 1)['), content=source.slice(source.indexOf('let paper-fit-width')); const a=content.indexOf('#text("Alpha")'), join=content.indexOf('#text(" / ")'), b=content.indexOf('#text("Beta")'), cap=content.indexOf('#text("Caption")'), image=content.indexOf('#image("assets/0.svg"');
 assert.ok(page>=0 && a>=0 && a<join && join<b && b<cap && cap<image); assert.equal(content.split('"Alpha"').length-1,1); assert.match(source,/let overhead = measure/); assert.match(content,/#set text\(size: 10pt\)/); assert.equal(expected.find(x=>x.id==='a').text,'Alpha / Beta');
});
for(const variant of ['long','nonadjacent','heading','edited-long','source-mismatch']) test(`${variant} remains in the preceding flow`,async()=>{
 const {source}=await run(variant); const page=source.indexOf('#page(columns: 1)['); const marker=source.indexOf('id: "a"'); assert.ok(marker<page);
});
test('float placement retains the original flow',async()=>{const {source}=await run('positive','float'); assert.ok(source.indexOf('id: "a"')<source.indexOf('let overhead = measure'));});

