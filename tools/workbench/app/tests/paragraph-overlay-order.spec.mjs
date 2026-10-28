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
