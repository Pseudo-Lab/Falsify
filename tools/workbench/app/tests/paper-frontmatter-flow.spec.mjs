import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const bytes=new TextEncoder().encode('source'), pdf=new TextEncoder().encode('%PDF-1.7');
const hash=createHash('sha256').update(bytes).digest('hex');
async function render({box=[40,510,360,540],pageIndex=0,size=7.5,mode='measured-continuous',columns=2,kind='paragraph'}={}) {
 const body='Body text '.repeat(30), note='Affiliation note';
 const block=(id,text,start,style,pi)=>({id,text,source:{pageIndex:pi,range:{start,end:start+text.length},lines:[],characters:[{start,end:start+text.length,styleId:style}]}});
 const document={schema:'falsify.paper-document.v1',sourceSha256:hash,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'body',size:10},{id:'note',size}],blocks:[block('body',body,0,'body',0),block('note',note,body.length,'note',pageIndex)],assets:[]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items:[{kind:'paragraph',columns,span:columns===2?'column':'page',blockIds:['body'],source:{pageIndex:0,bbox:[40,300,190,490]}},{kind,columns:1,span:'page',blockIds:['note'],source:{pageIndex,bbox:box}}]};
 let source,expected;
 await composeDocument({document,sourceBytes:bytes,flow,layoutMode:mode},{compile:async p=>(source=p.source,pdf),outputCheck:async p=>(expected=p.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})});
 return {source,expected};
}
test('small bottom title-page note follows body in continuous columns at source size',async()=>{
 const {source,expected}=await render(); assert.doesNotMatch(source,/#page\(columns: 1\)/); assert.ok(source.indexOf('Body text')<source.indexOf('Affiliation note')); assert.match(source,/#set text\(size: 7.5pt\)/); assert.deepEqual(expected.map(x=>x.id),['body','note']);
});
test('other geometry, size, page, and single-column sources retain existing bands',async()=>{
 for(const options of [{box:[40,300,360,330]},{box:[40,510,360,590]},{box:[-1,510,360,540]},{pageIndex:1},{size:10},{kind:'heading'}]) assert.match((await render(options)).source,/#page\(columns: 1\)/,JSON.stringify(options));
 const single=await render({columns:1}); assert.doesNotMatch(single.source,/#set page\([^\n]*columns: 2/); assert.doesNotMatch(single.source,/#page\(columns: 1\)/);
});
