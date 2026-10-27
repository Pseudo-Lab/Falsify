import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLinkPlan} from '../src/paper-link-plan.mjs';
const hash='a'.repeat(64);
function fixture(){
 const b=(id,page,start,end,text,parentBlockId)=>({id,text,parentBlockId,source:{pageIndex:page,range:{start,end}}});
 const document={sourceSha256:hash,blocks:[b('p',0,0,12,'same same xx'),b('q',1,0,6,'target'),b('label',1,6,8,'xy')],assets:[{id:'a'}]};
 const flow={sourceSha256:hash,fragments:[b('p1',0,0,5,'same ','p'),b('p2',0,5,12,'same xx','p')],items:[{id:'one',kind:'paragraph',source:{pageIndex:0},blockIds:['p1','p2']},{id:'two',kind:'paragraph',source:{pageIndex:1},blockIds:['q']},{id:'image',kind:'asset',source:{pageIndex:1},blockIds:['label'],assetIds:['a']}]};
 const link=(id,range,uri='https://example.org')=>({id,uri,external:true,source:{pageIndex:0},relation:{ranges:[{blockId:'p',...range}],assetIds:[]}});
 return {document,flow,links:{sourceSha256:hash,links:[link('first',{start:0,end:4}),link('second',{start:5,end:9}),link('wrap',{start:3,end:7},'https://wrap')]},link};
}
test('projects exact occurrences and fragments, diagnoses conflicts, preserves input',()=>{
 const x=fixture(), before=structuredClone({document:x.document,flow:x.flow,links:x.links}); const p=buildLinkPlan(x);
 assert.deepEqual({document:x.document,flow:x.flow,links:x.links},before); assert.deepEqual(p.sourceRuns.filter(r=>r.linkIds.includes('second')).map(r=>[r.blockId,r.start,r.end]),[['p2',5,9]]);
 assert.deepEqual(p.sourceRuns.filter(r=>r.linkIds.includes('wrap')).map(r=>[r.blockId,r.start,r.end]),[['p1',3,5],['p2',5,7]]);
 assert.equal(p.diagnostics.filter(d=>d.code==='source-link-conflict').length,2);
});
test('merges duplicate links and keeps IDs, but distinct overlapping links remain separate',()=>{
 const x=fixture(); x.links.links=[x.link('a',{start:0,end:4}),x.link('b',{start:1,end:5}),x.link('c',{start:2,end:3},'https://different')];
 const p=buildLinkPlan(x); assert.deepEqual(p.sourceRuns.find(r=>r.uri==='https://example.org').linkIds,['a','b']); assert.equal(p.sourceRuns.length,2); assert.ok(p.sourceRuns.every(r=>r.conflicted));
});
test('resolves text, asset and page anchors and marks changed targets',()=>{
 const x=fixture(); const internal=(id,relation)=>({id,uri:'#original',external:false,source:{pageIndex:0},relation:{ranges:[{blockId:'p',start:0,end:4}],assetIds:[]},target:{status:'resolved',pageIndex:1,relation}});
 x.links.links=[internal('t',{status:'text',blockId:'q',start:1,end:2}),internal('a',{status:'asset',assetId:'a'}),internal('p',{status:'page-anchor'})];
 let p=buildLinkPlan(x); assert.equal(p.targets.length,3); assert.ok(p.targets.some(t=>t.assetItemId==='image')); assert.ok(p.targets.some(t=>t.blockId==='q'&&t.start===1)); assert.ok(p.targets.some(t=>t.blockId==='q'&&t.start===0));
 x.edits=[{id:'e',blockId:'q',pageIndex:1,start:1,end:2,before:'a',after:''}]; p=buildLinkPlan(x); assert.ok(p.diagnostics.some(d=>d.code==='target-changed'&&d.change==='deleted')); assert.equal(p.sourceRuns.find(r=>r.linkIds.includes('t')).destinationStatus,'deleted'); assert.ok(p.targets.some(t=>t.status==='deleted'&&t.linkIds.includes('t')));
 x.edits[0].after='X'; p=buildLinkPlan(x); assert.ok(p.diagnostics.some(d=>d.code==='target-changed'&&d.change==='replaced'));
});
test('native edits inherit only contained links; segment-local anchors remain unmapped',()=>{
 const x=fixture(); x.links.links=[x.link('a',{start:0,end:4})]; x.edits=[{id:'inside',blockId:'p',pageIndex:0,start:1,end:3,before:'am',after:'XX'},{id:'cross',blockId:'p',pageIndex:0,start:3,end:6,before:'e s',after:'Y'},{id:'legacy',segmentId:'p',pageIndex:0,anchor:{start:0,end:4},before:'same',after:'else'}];
 const p=buildLinkPlan(x); assert.deepEqual(p.changes[0].inherit,{linkIds:['a'],uri:'https://example.org'}); assert.equal(p.changes[1].inherit,null); assert.equal(p.changes[1].portions.length,1); assert.ok(p.diagnostics.some(d=>d.code==='edit-unmapped'&&d.editId==='legacy'));
});
test('asset-owned text is excluded and asset relation retained; mismatched hashes rejected',()=>{
 const x=fixture(); x.links.links=[{id:'a',external:true,uri:'x',source:{pageIndex:1},relation:{ranges:[{blockId:'label',start:6,end:8}],assetIds:['a']}}]; const p=buildLinkPlan(x);
 assert.deepEqual(p.sourceRuns,[]); assert.equal(p.sourceAssets[0].assetItemId,'image'); x.flow.sourceSha256='b'; assert.throws(()=>buildLinkPlan(x),/hash mismatch/);
});

test('page anchor skips edited first body characters',()=>{
 const x=fixture(); x.links.links=[{id:'p',uri:'#page=2',external:false,source:{pageIndex:0},relation:{ranges:[{blockId:'p',start:0,end:4}],assetIds:[]},target:{status:'resolved',pageIndex:1,relation:{status:'page-anchor'}}}];
 x.edits=[{blockId:'q',pageIndex:1,start:0,end:3,before:'tar',after:''}];
 const p=buildLinkPlan(x); assert.equal(p.targets[0].blockId,'q'); assert.equal(p.targets[0].start,3);
});
