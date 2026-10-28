import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperFlow} from '../src/paper-flow.mjs';
import {buildFurniturePlan} from '../src/paper-furniture.mjs';

function fixture() {
  const document={schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[],blocks:[],assets:[],styles:[{id:'body',size:10},{id:'large',size:11}]},drawings=[];
  for(let pi=0;pi<5;pi++) {
    document.pages.push({sourcePageIndex:pi,width:400,height:600});
    const add=(id,text,bbox,styleId,pos)=>document.blocks.push({id:id+pi,kind:'paragraph',text,styleId,assetIds:[],source:{pageIndex:pi,bbox,range:{start:pos*1000,end:pos*1000+text.length},readerPosition:pos,lines:[{bbox}]} });
    add('body','Scientific body describes observations and experimental methods. '.repeat(3),[20,150,370,190],'body',0);
    add('publisher','Journal title',[30,574,130,584],'large',1);
    add('notice','Training notice',[25,580,250,589],'body',2);
    drawings.push({pageIndex:pi,bbox:[20,579,380,591],operation:'fill'});
  }
  return {document,drawings};
}

test('repeated overlapping footer lines on a shallow band become furniture without changing source',()=>{
  const {document,drawings}=fixture(),before=structuredClone({document,drawings});
  const flow=buildPaperFlow(document,{drawings}), plan=buildFurniturePlan({document,flow});
  assert.deepEqual({document,drawings},before);
  for(let pi=0;pi<5;pi++) {
    for(const id of ['publisher','notice']) {
      const item=flow.items.find(i=>i.blockIds.includes(id+pi));
      assert.equal(item.kind,'footer'); assert.ok(plan.excludedItemIds.includes(item.id));
      assert.ok(plan.pages[pi].footer.some(e=>e.blockId===id+pi && e.text===document.blocks.find(b=>b.id===id+pi).text));
    }
    const body=flow.items.find(i=>i.blockIds.includes('body'+pi));assert.equal(body.kind,'paragraph');assert.ok(!plan.excludedItemIds.includes(body.id));
  }
  const edited=buildFurniturePlan({document,flow,editedBlockIds:['notice0']});
  assert.ok(!edited.excludedBlockIds.includes('notice0'));assert.ok(edited.excludedBlockIds.includes('publisher0'));
});

test('nearby figure artwork and a nonrepeated outside note block promotion',()=>{
  const {document,drawings}=fixture();
  document.assets.push({id:'plot',source:{pageIndex:0,bbox:[30,565,200,590]}});
  document.blocks.push({id:'note',kind:'paragraph',text:'Unique scientific note',styleId:'body',assetIds:[],source:{pageIndex:1,bbox:[25,593,200,599],range:{start:4000,end:4022},readerPosition:4,lines:[{bbox:[25,593,200,599]}]}});
  const flow=buildPaperFlow(document,{drawings}),plan=buildFurniturePlan({document,flow});
  for(const id of ['publisher0','notice0','publisher1','notice1','note']) {
    const item=flow.items.find(i=>i.blockIds.includes(id));assert.equal(item.kind,'paragraph');assert.ok(!plan.excludedItemIds.includes(item.id));
  }
  for(const id of ['publisher2','notice2']) assert.ok(plan.excludedBlockIds.includes(id));
});
