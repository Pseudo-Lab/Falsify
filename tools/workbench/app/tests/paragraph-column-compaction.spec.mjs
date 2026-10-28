import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compactDocumentFlow} from '../src/paragraph-vendor/document-flow.mjs';

test('selected-column continuation retains its mapping without whole-page compaction',async()=>{
  const pdf=new Uint8Array([1,2,3]);
  const map=[
    {sourcePageIndex:0,outputPageIndex:0,continuationPageIndices:[1],flowColumn:{x0:300,x1:550}},
    {sourcePageIndex:1,outputPageIndex:2,continuationPageIndices:[]},
  ];
  const result=await compactDocumentFlow(()=>{throw Error('whole-page engine must not open');},new Uint8Array([4]),pdf,[],map,8,'compatible-groups');
  assert.equal(result.pdf,pdf);
  assert.deepEqual(result.sourcePageMap,map);
  assert.equal(result.addedPages,1);
  assert.deepEqual(result.flowGroups,[]);
});
