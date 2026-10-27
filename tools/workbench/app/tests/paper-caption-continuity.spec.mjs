import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperFlow} from '../src/paper-flow.mjs';

function fixture(barrier) {
 const blocks=[];
 const add=(id,text,start,box,lines)=>{const chars=[...text].map((_,i)=>({start:start+i,end:start+i+1,styleId:'s',bbox:[box[0]+i*5,box[1],box[0]+i*5+4,box[1]+8]})); const b={id,kind:'paragraph',text,assetIds:[],source:{pageIndex:0,bbox:box,range:{start,end:start+text.length},readerPosition:start,characters:chars,lines:lines||[{bbox:box,range:{start,end:start+text.length}}]}};blocks.push(b);return b;};
 const cap=add('cap','Fig. 1 caption',0,[20,100,180,108]);
 const host=add('host','abcdefghij',cap.source.range.end,[20,110,180,118]);
 const next=add('next','continuation',host.source.range.end,[20,120,180,128]);
 add('number','2',100,[44,110,48,118]);
 if(barrier) add('barrier',barrier==='caption'?'Fig. 2 other':'ordinary body',200,[20,119,180,121]);
 return {schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[],styles:[{id:'s',fontName:'Times',size:10}]};
}
test('caption continues after an inline numeric insertion while retaining IDs and joiners',()=>{
 const d=fixture(), f=buildPaperFlow(d), cap=f.items.find(i=>i.kind==='caption'), map=new Map([...d.blocks,...f.fragments].map(b=>[b.id,b]));
 assert.equal(cap.blockIds.length,5); assert.equal(cap.blockIds[0],'cap'); assert.equal(cap.blockIds[2],'number'); assert.equal(cap.blockIds[4],'next');
 assert.deepEqual(cap.joiners,[' ','','',' ']);
 assert.equal(cap.blockIds.map((id,i)=>map.get(id).text+(cap.joiners[i]||'')).join(''),'Fig. 1 caption abcde2fghij continuation');
 assert.deepEqual(cap.blockIds.map(id=>map.get(id).source.range),[{start:0,end:14},{start:14,end:19},{start:100,end:101},{start:19,end:24},{start:24,end:36}]);
});
for(const kind of ['body','caption']) test(`${kind} is a geometric barrier to caption continuation`,()=>{
 const f=buildPaperFlow(fixture(kind)), cap=f.items.find(i=>i.kind==='caption'); assert.ok(!cap.blockIds.includes('next'));
});
