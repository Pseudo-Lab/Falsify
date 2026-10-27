import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperFlow} from '../src/paper-flow.mjs';

test('caption union across measured columns stays in column flow while a genuine wide line spans',()=>{
 const blocks=[]; let offset=0;
 const add=(id,text,box,lines=1)=>{const start=offset; offset+=text.length; const lineBoxes=Array.from({length:lines},(_,i)=>[box[0],box[1]+i*10,box[2],box[1]+i*10+8]); blocks.push({id,kind:'paragraph',text,assetIds:[],source:{pageIndex:0,bbox:box,range:{start,end:offset},readerPosition:blocks.length,characters:[...text].map((_,i)=>({start:start+i,end:start+i+1,styleId:'s',bbox:box})),lines:lineBoxes.map(bbox=>({bbox,range:{start,end:offset}}))}});};
 add('l1','body left one',[20,40,180,48]); add('l2','body left two',[20,60,180,68]); add('r1','body right one',[220,40,380,48]); add('r2','body right two',[220,60,380,68]);
 add('cap','Figure 1. caption',[20,110,180,138],3); add('cont','continuation',[220,110,380,138],3);
 add('wide','A real wide paragraph',[20,180,380,190]);
 const d={schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[],styles:[{id:'s',fontName:'Times',size:10}]};
 const flow=buildPaperFlow(d),cap=flow.items.find(i=>i.blockIds.includes('cap')),wide=flow.items.find(i=>i.blockIds.includes('wide'));
 assert.deepEqual(cap.blockIds,['cap','cont']); assert.deepEqual(cap.joiners,[' ']); assert.equal(cap.columns,1); assert.equal(cap.span,'page'); assert.equal(cap.measuredColumns,2); assert.deepEqual(cap.source.bbox,[20,110,380,138]);
 assert.equal(wide.columns,1); assert.equal(wide.span,'page');
});
import {createHash,webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;

test('linked caption renders whole inline item once and validates ownership',async()=>{
 const src=new TextEncoder().encode('source'), sha=createHash('sha256').update(src).digest('hex');
 const blocks=[['a','Fig. 1 ',0],['b','2',7],['c',' results',8]].map(([id,text,start])=>({id,text,source:{pageIndex:0,range:{start,end:start+text.length},lines:[]}}));
 const doc={schema:'falsify.paper-document.v1',sourceSha256:sha,pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[]};
 blocks[1].source.characters=[{start:7,end:8,styleId:'n'}];doc.styles=[{id:'n',size:7,fontName:'Times-Bold'}];
 const links={sourceSha256:sha,links:[{id:'cite',external:true,uri:'https://example.org',source:{pageIndex:0},relation:{ranges:[{blockId:'b',start:7,end:8}],assetIds:[]}}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"></svg>');
 const asset={id:'figure',kind:'asset',blockIds:[],assetIds:['img'],captionIds:['a','b','c'],captionPositions:{a:'below',b:'below',c:'below'},columns:2};
 const cap={id:'cap',kind:'caption',blockIds:['a','b','c'],joiners:['-','+'],inline:true,columns:2};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:sha,items:[asset,cap]}; let source,expected;
 const deps={compile:async x=>(source=x.source,new TextEncoder().encode('%PDF-1.7\n')),outputCheck:async x=>(expected=x.expectedBlocks,{checks:{content:{status:'pass'}},findings:[]})};
 await composeDocument({document:doc,sourceBytes:src,flow,links,assets:[{id:'img',content:{representation:'svg',bytes:svg}}]},deps);
 assert.deepEqual(expected.map(x=>x.text),['Fig. 1 -2+ results']);
 assert.equal(source.split('#text("-")').length-1,1);assert.equal(source.split('#text("+")').length-1,1);
 for(const text of ['Fig. 1 ',' results']) assert.equal(source.split(`#text("${text}")`).length-1,1);
 assert.match(source,/#link\("https:\/\/example.org"\)\[#text\(size: 7pt, weight: "bold", "2"\)\]/);
 assert.ok(source.indexOf('#image(')<source.indexOf('#text("Fig. 1 ")'));
 const invalid=structuredClone(flow);invalid.items[0].captionPositions.b='above';
 await assert.rejects(composeDocument({document:doc,sourceBytes:src,flow:invalid,assets:[{id:'img',content:{representation:'svg',bytes:svg}}]},deps),/Incomplete or inconsistent caption link|Inline blocks must be consecutive/);
});

test('grouped caption association requires an unambiguous same-page candidate',()=>{
 function make(extra){
  let n=0;const add=(id,text,box,kind='paragraph',assetIds=[])=>{const start=n;n+=text.length;return {id,kind,text,assetIds,source:{pageIndex:0,bbox:box,range:{start,end:n},readerPosition:start,characters:[...text].map((_,i)=>({start:start+i,end:start+i+1,styleId:'s',bbox:box})),lines:[0,1,2].map(i=>({bbox:[box[0],box[1]+i*10,box[2],box[1]+i*10+8],range:{start,end:n}}))}}};
  const cap=add('cap','Fig. 1 caption',[20,200,180,228]),cont=add('cont',' continuation',[220,200,380,228]);
  const box=extra?[20,100,195,190]:[20,100,380,190];const fig=add('fig','',box,'figure',['img']);const blocks=[fig,cap,cont];const assets=[{id:'img',source:{pageIndex:0,bbox:box}}];
  if(extra){blocks.push(add('fig2','',[205,100,380,190],'figure',['img2']));assets.push({id:'img2',source:{pageIndex:0,bbox:[205,100,380,190]}})}
  return {schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets,styles:[{id:'s',fontName:'Times',size:10}]};
 }
 const good=buildPaperFlow(make(false));assert.deepEqual(good.items.find(i=>i.kind==='asset').captionIds,['cap','cont']);
 const ambiguous=buildPaperFlow(make(true));assert.ok(ambiguous.items.filter(i=>i.kind==='asset').every(i=>!i.captionIds.length));
});
test('continuous mode applies measured alternate order without changing default order',async()=>{
 const src=new TextEncoder().encode('source'),sha=createHash('sha256').update(src).digest('hex');
 const blocks=[['a','A'.repeat(160)],['cap','Fig. 1'],['right','Right body'],['wide','Wide section']].map(([id,text],i)=>({id,text,source:{pageIndex:0,range:{start:i*200,end:i*200+text.length},lines:[]}}));
 const doc={schema:'falsify.paper-document.v1',sourceSha256:sha,pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[]};
 const item=(id,kind,columns,span,order,continuousColumns)=>({id,kind,blockIds:[id],columns,span,source:{pageIndex:0},continuousPosition:order,...(continuousColumns?{continuousColumns}:{})});
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:sha,items:[item('a','paragraph',2,'column',0,2),{...item('cap','caption',1,'page',2,2),measuredColumns:2},item('right','paragraph',2,'column',1,2),item('wide','paragraph',1,'page',3)]};
 const run=async layoutMode=>{let expected,source;await composeDocument({document:doc,sourceBytes:src,flow,layoutMode},{compile:async x=>(source=x.source,new TextEncoder().encode('%PDF-1.7\n')),outputCheck:async x=>(expected=x.expectedBlocks.map(b=>b.id),{checks:{content:{status:'pass'}},findings:[]})});return {expected,source};};
 const normal=await run(undefined),continuous=await run('measured-continuous');
 assert.deepEqual(normal.expected,['a','cap','right','wide']);assert.deepEqual(continuous.expected,['a','right','cap','wide']);assert.match(continuous.source,/#page\(columns: 1\)/);
});
