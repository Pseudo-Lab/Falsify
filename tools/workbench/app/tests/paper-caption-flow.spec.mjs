import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperFlow} from '../src/paper-flow.mjs';
const make=(id,text,start,box,style='regular',lines=1,pageIndex=0)=>({id,kind:'paragraph',text,assetIds:[],styleId:style,source:{pageIndex,bbox:box,range:{start,end:start+text.length},readerPosition:start,characters:[...text].map((_,i)=>({start:start+i,end:start+i+1,styleId:style,bbox:[box[0]+i,box[1],box[0]+i+1,box[1]+8]})),lines:Array.from({length:lines},(_,i)=>({bbox:[box[0],box[1]+i*10,box[2],box[1]+i*10+8]}))}});
const doc=blocks=>({schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[],styles:[{id:'regular',fontName:'Serif-Regular',size:7},{id:'other',fontName:'Serif-Regular',size:10}]});
const group=f=>f.items.find(i=>i.kind==='caption');
test('adjacent measured caption continuation preserves every source ID and text',()=>{
 const a=make('a','Fig. 1. value ',0,[20,100,180,118],'regular',2),b=make('b','3.14 ± 2',a.text.length,[20,120,180,138],'regular',2),d=doc([a,b]),before=structuredClone(d),f=buildPaperFlow(d);
 assert.deepEqual(d,before);assert.deepEqual(group(f).blockIds,['a','b']);assert.deepEqual(group(f).joiners,[' ']);assert.deepEqual(f.items.flatMap(i=>i.blockIds).sort(),['a','b']);assert.ok(f.diagnostics.some(x=>x.code==='caption-association-unresolved'));
});
test('body or a competing caption blocks grouping even with nearby geometry',()=>{
 const a=make('a','Fig. 1. ',0,[20,100,180,118],'regular',2),b=make('b','continuation',a.text.length,[20,126,180,144],'regular',2),body=make('body','body',50,[20,119,180,125],'other');
 assert.deepEqual(group(buildPaperFlow(doc([a,body,b]))).blockIds,['a']);
 const other=make('other','Fig. 2. other',50,[20,119,180,125]);assert.deepEqual(group(buildPaperFlow(doc([a,other,b]))).blockIds,['a']);
});
test('two-column wrap requires aligned geometry and matching font',()=>{
 const a=make('a','Fig. 1. ',0,[20,100,180,138],'regular',4),b=make('b','continued',a.text.length,[220,100,380,118],'regular',2);
 assert.deepEqual(group(buildPaperFlow(doc([a,b]))).blockIds,['a','b']);
 b.source.bbox=[220,160,380,178];assert.deepEqual(group(buildPaperFlow(doc([a,b]))).blockIds,['a']);
 b.source.bbox=[220,100,380,118];b.source.characters.forEach(c=>c.styleId='other');assert.deepEqual(group(buildPaperFlow(doc([a,b]))).blockIds,['a']);
});
test('cross-page artwork remains unlinked with an explicit diagnostic',()=>{
 const a=make('a','Fig. 1. ',0,[20,100,180,118],'regular',2),b=make('b','continued',a.text.length,[20,120,180,138],'regular',2),d=doc([a,b]);d.pages.push({sourcePageIndex:1,width:400,height:600});d.assets.push({id:'asset',source:{pageIndex:1,bbox:[20,50,380,400]}});
 const f=buildPaperFlow(d);assert.deepEqual(group(f).blockIds,['a','b']);assert.deepEqual(f.items.find(i=>i.kind==='asset').captionIds,[]);assert.ok(f.diagnostics.some(x=>x.code==='caption-association-unresolved' && x.itemId===group(f).id));
});
test('new caption member boundaries keep the previous flow word separator',()=>{
 const a=make('a','Fig. 1. line represents',0,[20,100,180,118],'regular',2),b=make('b','mean and error bars.',a.text.length,[20,120,180,138],'regular',2);
 const item=group(buildPaperFlow(doc([a,b]))),byId=new Map([[a.id,a],[b.id,b]]);
 assert.equal(item.blockIds.map((id,i)=>byId.get(id).text+(item.joiners[i]||'')).join(''),'Fig. 1. line represents mean and error bars.');
});
