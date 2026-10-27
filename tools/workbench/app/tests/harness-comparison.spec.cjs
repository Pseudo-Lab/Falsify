const {test}=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');global.crypto=webcrypto;
const C=require('../dist/harness-comparison.js');
const strategy={schema:'falsify.portable-strategy.v1',name:'scan',version:'1',parameters:{threshold:0.2}};
const h=(path,p=strategy)=>({settings:{portableStrategy:p,comparisonRubric:'rubric-v1'},adapter:{type:'stdio',executable:path}});
const run=(id,overrides={})=>({id,role:'blue',sourceHash:'c'.repeat(64),fileHash:'f'.repeat(64),inputMode:'text',model:'model-a',maxCalls:4,level:null,provenance:'local-codex',harness:h('/a'),harnessHash:'a'.repeat(64),...overrides});
test('portable identity is explicit and independent of command path',async()=>{assert.equal(await C.strategyHash(h('/a')),await C.strategyHash(h('/b')));assert.notEqual(await C.strategyHash(h('/a')),await C.strategyHash(h('/b',{...strategy,version:'2'})));assert.notEqual(await C.strategyHash(h('/a')),await C.strategyHash(h('/b',{...strategy,parameters:{threshold:0.3}})));assert.equal(await C.strategyHash({settings:{}}),null);});
test('conditions exclude missing and differing case, model, budget, rubric and provenance',()=>{const a=run('a');for(const [change,reason] of [[{sourceHash:'other'},'입력 텍스트 해시'],[{role:'red'},'역할'],[{model:'unknown'},'모델'],[{model:'other'},'모델'],[{maxCalls:8},'예산'],[{provenance:'manual-unverified'},'출처'],[{harness:{settings:{portableStrategy:strategy}}},'rubric'],[{harness:{settings:{comparisonRubric:'rubric-v1'}}},'portable']])assert.ok(C.differences(a,run('b',change)).some(x=>x.includes(reason)),reason);});
test('snapshots do not add runs; unknown failures and cost remain unknown',()=>{const a=run('a'),b=run('b',{harness:h('/b'),harnessHash:'b'.repeat(64)}),s=run('s',{snapshotOf:'a'});const x=C.compare([a,b,s],[{runId:'s',verdict:'uncertain'}],a);assert.equal(x.observed,2);assert.equal(x.groups.length,1);assert.equal(x.groups[0].runs.length,2);assert.equal(x.uncertain,1);assert.equal(x.unreviewed,1);assert.equal(x.missingAttempts,null);assert.equal(x.cost,null);assert.equal(x.rows[0].strategy,x.rows[1].strategy);});

test('exact file and known input footprint are required',()=>{
 const a=run('a');
 for(const b of [run('b',{fileHash:'a'.repeat(64)}),run('b',{fileHash:null}),run('b',{inputMode:undefined}),run('b',{sourceHash:'bad'})])assert.ok(C.differences(a,b).length);
 const ref={fileHash:a.fileHash,sourceHash:a.sourceHash,page:1,bbox:[0,0,10,20],rotation:0,width:20,height:40,mime:'image/png',sha256:'a'.repeat(64),provenance:'client-declared-pdf-association',artifact:'unavailable'};
 const v=run('v',{inputMode:'visual',visualEvidence:[ref,{...ref,page:2}]});
 assert.deepEqual(C.differences(v,run('w',{inputMode:'visual',visualEvidence:[{...ref,page:2},ref]})),[]);
 assert.ok(C.differences(v,run('w',{inputMode:'visual',visualEvidence:[{...ref,sha256:'b'.repeat(64)},{...ref,page:2}]})).length);
 assert.ok(C.differences(v,a).length);
 assert.ok(C.differences({...v,inputMode:undefined},{...v,inputMode:undefined}).length);
 assert.ok(C.differences({...a,provenance:'imported-unverified'},{...a,provenance:'imported-unverified'}).length);
 assert.ok(C.differences(v,run('w',{inputMode:'visual',visualEvidence:[{...ref,width:1}]})).length);
});
test('comparison exposes parameter differences and human notes without ranking',()=>{const a=run('a'),b=run('b',{harness:h('/b',{...strategy,parameters:{threshold:0.3}})});const result=C.compare([a,b],[{runId:'b',verdict:'mixed',note:'Needs human review'}],a);assert.deepEqual(result.rows[1].parameterDifferences,['threshold']);assert.equal(result.rows[1].reviewNote,'Needs human review');assert.equal(result.groups.length,2);});
test('attempt observations group only matching known file, source, role, model and budget',()=>{const r=run('a'),a={role:r.role,sourceHash:r.sourceHash,fileHash:r.fileHash,model:r.model,budget:r.maxCalls,harnessHash:r.harnessHash,harnessName:'h',harnessVersion:'1',status:'failed',durationMs:10,calls:null};const result=C.observedAttempts([a,{...a,status:'completed',calls:2},{...a,fileHash:'b'.repeat(64)}],r);assert.equal(result.matched,2);assert.equal(result.unmatched,1);assert.deepEqual(result.groups[0].counts,{completed:1,failed:1,cancelled:0,unknown:0});assert.equal(result.groups[0].calls,2);assert.equal(result.groups[0].callsUnknown,1);});
