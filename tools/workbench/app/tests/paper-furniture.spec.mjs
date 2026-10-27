import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFurniturePlan} from '../src/paper-furniture.mjs';

function fixture() {
 const document={schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:Array.from({length:3},(_,i)=>({sourcePageIndex:i,width:400,height:600})),blocks:[],assets:[]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:document.sourceSha256,items:[],fragments:[]};
 function text(pi,id,value,box,kind='paragraph') {const source={pageIndex:pi,bbox:box,range:{start:pi*100,end:pi*100+value.length},characters:[{start:pi*100,end:pi*100+value.length,styleId:'s'}]};document.blocks.push({id,text:value,styleId:'s',source,assetIds:[]});flow.items.push({id:`i-${id}`,kind,blockIds:[id],assetIds:[],source:{pageIndex:pi,bbox:box}});}
 function image(pi,id,box,bytes=[1,2],mixed=false) {const a=`a-${id}`,source={pageIndex:pi,bbox:box,transform:[10,0,0,10,box[0],box[1]]};document.assets.push({id:a,kind:'image',source,content:{representation:'mupdf-decoded-png',bytes:Uint8Array.from(bytes),width:2,height:2,alpha:false,mask:null}});document.blocks.push({id,text:mixed?'scientific label':'',source,assetIds:[a]});flow.items.push({id:`i-${id}`,kind:'asset',blockIds:[id],assetIds:[a],source,renderAssetId:`crop-${id}`});}
 for(let i=0;i<3;i++){if(i<2)text(i,`h${i}`,i?'Variant':'Title header',[20,40,150,50],'header');text(i,`f${i}`,'Footer',[20,555,100,565],'footer');text(i,`n${i}`,`${i+1} / 3`,[340,555,370,565]);text(i,`body${i}`,'body 1 / 3',[20,200,200,220]);image(i,`figure${i}`,[30,250,40,260]);if(i<2)image(i,`logo${i}`,[20,38,30,48]);}
 return {document,flow};
}
test('per-page furniture, exact counters and image ownership preserve body and inputs',()=>{
 const {document,flow}=fixture(),before=structuredClone({document,flow});const p=buildFurniturePlan({document,flow});
 assert.deepEqual({document,flow},before);assert.deepEqual(buildFurniturePlan({document,flow}),p);
 assert.equal(p.pages.length,3);assert.deepEqual(p.pages.map(x=>x.header.map(e=>e.kind)),[['text','asset'],['text','asset'],[]]);
 assert.equal(p.pages.flatMap(x=>x.footer).filter(e=>e.kind==='counter').length,3);
 assert.ok(p.excludedItemIds.includes('i-logo0'));assert.ok(!p.excludedItemIds.includes('i-figure0'));assert.ok(!p.excludedBlockIds.includes('body0'));
 assert.equal(p.pages[0].header[1].renderAssetId,'crop-logo0');assert.deepEqual(p.pages[0].header[0].source.range,{start:0,end:12});
 assert.deepEqual(p.margins,{top:60,right:36,bottom:55,left:36});
});
test('edited blocks and edited fragment parents remain in flow; mixed ownership is retained',()=>{
 const {document,flow}=fixture();document.blocks.find(b=>b.id==='logo1').text='label';
 flow.fragments.push({...document.blocks.find(b=>b.id==='h0'),id:'fragment',parentBlockId:'parent'});flow.items.find(i=>i.id==='i-h0').blockIds=['fragment'];
 const p=buildFurniturePlan({document,flow,editedBlockIds:['parent','n1']});
 assert.ok(!p.excludedItemIds.includes('i-h0'));assert.ok(!p.excludedItemIds.includes('i-n1'));assert.ok(!p.excludedItemIds.includes('i-logo1'));assert.ok(!p.excludedItemIds.includes('i-logo0'));
 assert.equal(p.pages.flatMap(x=>x.footer).filter(e=>e.kind==='counter').length,2);
});
test('different bytes or mask cannot prove a repeated logo and impossible pages retain content',()=>{
 const {document,flow}=fixture();document.assets.find(a=>a.id==='a-logo1').content.mask={bytes:Uint8Array.of(9)};
 let p=buildFurniturePlan({document,flow});assert.ok(!p.excludedItemIds.includes('i-logo0'));
 document.pages[0].height=90;p=buildFurniturePlan({document,flow});assert.ok(p.diagnostics.some(d=>d.code==='furniture-impossible-space'));assert.deepEqual(p.excludedItemIds,[]);
});

test('identical header peers support an occurrence without text header, while body images stay body',()=>{
 const {document,flow}=fixture();const logo=document.assets.find(a=>a.id==='a-logo0'), original=flow.items.find(i=>i.id==='i-logo0');
 document.assets.push({...structuredClone(logo),id:'a-logo2',source:{...logo.source,pageIndex:2}});document.blocks.push({id:'logo2',text:'',source:{...logo.source,pageIndex:2},assetIds:['a-logo2']});flow.items.push({...structuredClone(original),id:'i-logo2',blockIds:['logo2'],assetIds:['a-logo2'],source:{...original.source,pageIndex:2}});
 const before=structuredClone({document,flow}),p=buildFurniturePlan({document,flow});assert.deepEqual({document,flow},before);assert.ok(p.excludedItemIds.includes('i-logo2'));for(let i=0;i<3;i++)assert.ok(!p.excludedItemIds.includes('i-figure'+i));
});
test('planner retains inferred edges beyond body but honors explicit source roles',()=>{
 const {document,flow}=fixture();
 const add=(id,text,box,kind,sourceKind)=>{const source={pageIndex:0,bbox:box,range:{start:500,end:500+text.length}};document.blocks.push({id,kind:sourceKind,text,source});flow.items.push({id:'i-'+id,kind,blockIds:[id],assetIds:[],source:{pageIndex:0,bbox:box}});};
 add('brand','Brand',[20,10,160,30],'heading','heading');add('note','Note',[20,580,160,590],'paragraph','paragraph');
 add('tag','Tagged header',[200,40,350,50],'header','header');
 const before=structuredClone({document,flow}),p=buildFurniturePlan({document,flow});assert.deepEqual({document,flow},before);
 assert.ok(!p.excludedItemIds.includes('i-h0'));assert.ok(!p.excludedItemIds.includes('i-f0'));assert.ok(p.excludedItemIds.includes('i-tag'));assert.ok(p.excludedItemIds.includes('i-h1'));assert.ok(p.excludedItemIds.includes('i-f1'));
});
