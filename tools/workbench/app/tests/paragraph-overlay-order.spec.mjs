import assert from 'node:assert/strict';
import {test} from 'node:test';
import {restoreSourceOrder} from '../src/paragraph-vendor/quality.mjs';

test('an interleaved paragraph retains its final painter slot above its mask',()=>{
  let objects=[10,11,2,3,5];
  const text=new Set([1,2,4,10,11]);
  const engine={page:1,M:{
    _FPDFPage_CountObjects:()=>objects.length,
    _FPDFPage_GetObject:(_,i)=>objects[i],
    _FPDFPageObj_GetType:h=>text.has(h)?1:2,
    _FPDFPage_RemoveObject:(_,h)=>{const i=objects.indexOf(h);if(i<0)return 0;objects.splice(i,1);return 1;},
    _FPDFPage_InsertObjectAtIndex:(_,h,i)=>{objects.splice(i,0,h);return 1;},
    _FPDFPage_InsertObject:(_,h)=>objects.push(h),
  },paragraphObjects:id=>id===7?[10,11]:[2]};
  const context={objects:[1,2,3,4,5],paras:[
    {id:7,handles:[1,4],slots:[0,3],topLevel:true,sharesObjects:false},
    {id:8,handles:[2],slots:[1],topLevel:true,sharesObjects:false},
  ]};
  const repairs=[],warnings=[];
  restoreSourceOrder(engine,context,repairs,warnings);
  assert.deepEqual(objects,[2,3,10,11,5]);
  assert.deepEqual(objects.filter(h=>!text.has(h)),[3,5]);
  assert.ok(warnings.some(w=>w.code==='interleaved_source_overlay_order'));
  assert.ok(!warnings.some(w=>w.severity==='error'));
});

function runOrder(source, current, paragraphs, currentById) {
  let objects=[...current];
  const engine={page:1,M:{
    _FPDFPage_CountObjects:()=>objects.length,
    _FPDFPage_GetObject:(_,i)=>objects[i],
    _FPDFPageObj_GetType:h=>h===3?2:1,
    _FPDFPage_RemoveObject:(_,h)=>{const i=objects.indexOf(h);if(i<0)return 0;objects.splice(i,1);return 1;},
    _FPDFPage_InsertObjectAtIndex:(_,h,i)=>{objects.splice(i,0,h);return 1;},
    _FPDFPage_InsertObject:(_,h)=>objects.push(h),
  },paragraphObjects:id=>currentById[id]||[]};
  const repairs=[],warnings=[];
  restoreSourceOrder(engine,{objects:source,paras:paragraphs},repairs,warnings);
  return {objects,repairs,warnings};
}
const para=(id,handles,slots,extra={})=>({id,handles,slots,topLevel:true,sharesObjects:false,...extra});

test('surviving source prefix remains below interleaved mask after replacement',()=>{
  const r=runOrder([1,3,4,5],[1,3,5,10],[para(7,[1,4],[0,2]),para(8,[5],[3])],{7:[1,10],8:[5]});
  assert.deepEqual(r.objects,[1,3,10,5]);
  assert.ok(!r.warnings.some(w=>w.severity==='error'));
});

test('fresh objects require a deleted source slot between surviving anchors',()=>{
  const r=runOrder([1,3,4],[1,3,4,10],[para(7,[1,4],[0,2])],{7:[1,10,4]});
  assert.deepEqual(r.objects,[1,3,4,10]);
  assert.ok(r.warnings.some(w=>w.code==='replacement_without_source_slot'));
});

test('shared, reused and missing source ownership leave order untouched',()=>{
  const cases=[
    {source:[1,3,4],current:[3,4,10],paras:[para(7,[1],[0],{sharesObjects:true}),para(8,[4],[2])],now:{7:[10],8:[4]},code:'paragraph_shares_objects'},
    {source:[1,3,4],current:[3,4],paras:[para(7,[1],[0]),para(8,[4],[2])],now:{7:[4],8:[]},code:'handle_identity_reused'},
    {source:[1,3,4],current:[3,10],paras:[para(7,[1],[0]),para(8,[4],[2])],now:{7:[10],8:[4]},code:'unrelated_object_missing'},
  ];
  for(const c of cases){
    const r=runOrder(c.source,c.current,c.paras,c.now);
    assert.deepEqual(r.objects,c.current);
    assert.ok(r.warnings.some(w=>w.code===c.code),`${c.code}: ${JSON.stringify(r.warnings)}`);
  }
});
