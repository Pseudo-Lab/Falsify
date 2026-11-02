import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceReconstructionPreview} from '../src/pdf-latex-workbench.mjs';
import {handoffReconstruction} from '../src/pdf-latex-workbench.mjs';
test('AI baseline handoff transfers the exact pair before explicit start; stale loading never starts AI',async()=>{
 const calls=[],input={project:{id:'exact'},initialArtifact:{pdfHash:'baseline'},reconstruction:{sourceHash:'original'},signal:new AbortController().signal};let current=true;
 const workbench={async loadReconstructed(v){assert.equal(v,input);calls.push('load');},async startLayoutReview(v){calls.push('start');assert.match(v.goal,/원본 PDF/);}};
 assert.equal(await handoffReconstruction({workbench,input,isCurrent:()=>current}),true);assert.deepEqual(calls,['load']);
 calls.length=0;assert.equal(await handoffReconstruction({workbench,input,isCurrent:()=>current,startAI:true}),true);assert.deepEqual(calls,['load','start']);
 calls.length=0;workbench.loadReconstructed=async()=>{calls.push('load');current=false;};assert.equal(await handoffReconstruction({workbench,input,isCurrent:()=>current,startAI:true}),false);assert.deepEqual(calls,['load']);
});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const pdf=name=>({name,destroyed:0,async destroy(){this.destroyed++;}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('stale delayed library cannot dispose the newer displayed pair',async()=>{
 let generation=1,shown=[pdf('previous')],disposals=0;const pending=defer();
 const dispose=async()=>{disposals++;const old=shown;shown=[];for(const d of old)await d.destroy();};
 const newer=[pdf('new original'),pdf('new baseline')],older=[pdf('old original'),pdf('old baseline')];
 const old=replaceReconstructionPreview({library:()=>pending.promise,isCurrent:()=>generation===1,dispose,load:()=>older.map(Promise.resolve.bind(Promise)),install:x=>{shown=x;}});
 generation=2;
 assert.equal(await replaceReconstructionPreview({library:async()=>({}),isCurrent:()=>generation===2,dispose,load:()=>newer.map(Promise.resolve.bind(Promise)),install:x=>{shown=x;}}),true);
 pending.resolve({});assert.equal(await old,false);assert.deepEqual(shown,newer);assert.equal(disposals,1);assert.equal(newer[0].destroyed+newer[1].destroyed,0);
});
test('stale pending documents destroy only their own pair, never the new preview',async()=>{
 let generation=1,shown=[];const first=defer(),second=defer(),oldPair=[pdf('old original'),pdf('old baseline')],newPair=[pdf('new original'),pdf('new baseline')];
 const dispose=async()=>{const old=shown;shown=[];for(const d of old)await d.destroy();};
 const old=replaceReconstructionPreview({library:async()=>({}),isCurrent:()=>generation===1,dispose,load:()=>[first.promise,second.promise],install:x=>{shown=x;}});await tick();
 generation=2;await replaceReconstructionPreview({library:async()=>({}),isCurrent:()=>generation===2,dispose,load:()=>newPair.map(Promise.resolve.bind(Promise)),install:x=>{shown=x;}});
 first.resolve(oldPair[0]);second.resolve(oldPair[1]);assert.equal(await old,false);assert.deepEqual(shown,newPair);assert.deepEqual(oldPair.map(d=>d.destroyed),[1,1]);assert.deepEqual(newPair.map(d=>d.destroyed),[0,0]);
});
test('current load failure destroys the fulfilled document and reports failure',async()=>{
 const task=pdf('loading task'),retained={loadingTask:task};let installed=false;
 await assert.rejects(replaceReconstructionPreview({library:async()=>({}),isCurrent:()=>true,dispose:async()=>{},load:()=>[Promise.resolve(retained),Promise.reject(new Error('failure'))],install:()=>{installed=true;}}),/미리보기를 열지 못했습니다/);
 assert.equal(task.destroyed,1);assert.equal(installed,false);
});
