const {test}=require('node:test');
const assert=require('node:assert/strict');
const X=require('../dist/external-exchange.js');
const P=require('../dist/external-proposals.js');
const G=require('../dist/paper-generation.js');
const fixture=require('./fixtures/external-ai-workflow.json');
const options=role=>({role,segments:fixture.segments,fileHash:fixture.fileHash});

test('RED answers accumulate, alternatives select atomically, deletion stays applicable',()=>{
 const collection=P.create(options('red'));
 collection.append(X.parse(JSON.stringify(fixture.redFirst),options('red')));
 collection.append(X.parse(JSON.stringify(fixture.redAlternative),options('red')));
 const items=collection.snapshot().items;assert.equal(items.length,3);
 collection.setEnabled(items[0].id,true);collection.setEnabled(items[2].id,true);
 let observed=[];collection.subscribe(s=>observed.push(s.items.filter(i=>i.enabled).map(i=>i.id)));
 collection.setEnabled(items[1].id,true);
 assert.deepEqual(collection.edits().map(i=>i.after),['360 participants [2]','']);
 assert.equal(observed.length,1);assert.equal(observed[0].includes(items[0].id),false);
 collection.setEnabled(items[1].id,false);
 assert.equal(collection.snapshot().items.length,3);assert.equal(collection.snapshot().batches.length,2);
 const restored=P.create(options('red'));restored.restore(collection.snapshot());
 assert.deepEqual(restored.edits(),collection.edits());
});

test('BLUE distinct unlocated concerns survive additive import',()=>{
 const collection=P.create(options('blue'));
 collection.append(X.parse('First concern: the conclusion overstates the evidence.',options('blue')));
 collection.append(X.parse('Second concern: follow-up duration is insufficient.',options('blue')));
 const s=collection.snapshot();assert.equal(s.items.length,2);
 assert.notEqual(s.items[0].rationale,s.items[1].rationale);
 collection.setEnabled(s.items[0].id,true);collection.setEnabled(s.items[1].id,true);
 assert.equal(collection.snapshot().items.filter(i=>i.enabled).length,2);
});

test('legacy structured evidence is preserved without binary/text hash confusion',()=>{
 const evidence=[{segmentId:'s1',quote:'Symptom intensity was not measured.',relation:'Contradictory evidence'}];
 const refs=[{url:'https://example.org/paper',description:'External source'}];
 const raw=JSON.stringify({schema:'falsify.document-blue.v1',sourceHash:'b'.repeat(64),findings:[{quote:'120 participants [1]',rationale:'Check sample size',evidence,references:refs}]});
 const result=X.parse(raw,{...options('blue'),sourceHash:'b'.repeat(64)});
 assert.deepEqual(result.items[0].evidence,evidence);assert.deepEqual(result.items[0].references,refs);
 assert.equal(result.diagnostics.some(d=>d.code==='file-hash-mismatch'),false);
});

test('matching text uses source offsets and human combination preserves parent linkage',()=>{
 const batch=X.parse(JSON.stringify({changes:[{before:'direct causality.',after:'direct causality is proven.'}]}),options('red'));
 assert.equal(batch.items[0].before,'direct cau-\nsality.');assert.equal(batch.items[0].matchStatus,'matched');
 const collection=P.create(options('red'));collection.append(batch);
 collection.append(X.parse(JSON.stringify({changes:[{before:'direct causality.',after:'a causal relationship.'}]}),options('red')));
 const items=collection.snapshot().items;
 const combined=collection.combine(items.map(i=>i.id),{...items[0],after:'direct causal control.'});
 collection.setEnabled(combined,true);
 const item=collection.snapshot().items.find(i=>i.id===combined);
 assert.equal(item.origin,'human');assert.deepEqual(item.parentIds,items.map(i=>i.id));
 assert.equal(collection.edits().length,1);assert.equal(collection.snapshot().batches.length,2);
});

test('generation key follows content, and a captured flush survives later background edits',async()=>{
 const a={fileHash:fixture.fileHash,revision:1,edits:[{before:'Alpha',after:'Beta'}]};
 const b={...a,edits:[{before:'Alpha',after:'Gamma'}]};
 assert.notEqual(G.key(a),G.key(b));assert.equal(G.key(a),G.key({...a,revision:99}));
 let finish;const seen=[];
 const scheduler=G.create({delayMs:0,generate:spec=>spec.edits[0].after==='Beta'?new Promise(r=>{finish=r}):Promise.resolve({text:'Gamma'}),onResult:r=>seen.push(r.text)});
 try{const clicked=scheduler.flush(a);scheduler.schedule(b);finish({text:'Beta'});
  assert.deepEqual(await clicked,{text:'Beta'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(seen,['Gamma']);
 }finally{scheduler.dispose();}
});
