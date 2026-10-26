import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ARCHIVE_SCHEMA,BUNDLE_SCHEMA,LEDGER_SCHEMA,MAX_ARCHIVE_BYTES,buildExperimentArchive,buildHarnessArchive,validateArchive,archiveHash,canonicalJSON,ReviewBundleError} from '../dist/review-bundle.mjs';

const require=createRequire(import.meta.url);
const H=require('../dist/harness-core.js'),Red=require('../dist/document-red-core.js'),Blue=require('../dist/document-blue-core.js'),Review=require('../dist/review-workbench.js');
const V={harness:H,red:Red,blue:Blue,review:Review};
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const redTexts=['Alpha does not show benefit in the cohort.','Only an association was observed in winter.','The sample excluded untreated controls.','Follow-up stopped before the endpoint.','Authors call the result conclusive.'];
const changed='Alpha does show benefit in the cohort.';
const join=rows=>rows.map(s=>s.text).join('\n\n');

async function fiveCase(){
  const redSegments=redTexts.map((text,i)=>({id:'s'+i,label:'p'+(i+1),text}));
  const blueSegments=redSegments.map((s,i)=>i===0?{...s,text:changed}:{...s});
  const redSource=await sha(join(redSegments)),blueSource=await sha(join(blueSegments));
  const redHash=await H.hash(H.builtin('red')),blueHash=await H.hash(H.builtin('blue'));
  const redHarness={config:H.builtin('red'),hash:redHash},blueHarness={config:H.builtin('blue'),hash:blueHash};
  const response={schema:Red.VERSION,revision:'synthetic-red',sourceHash:redSource,status:'ok',candidates:[{id:'c1',segmentId:'s0',level:1,before:redTexts[0],after:changed,rationale:'Synthetic contradiction.',evidence:[{segmentId:'s1',quote:redTexts[1],relation:'Synthetic qualification.'}],uncertainty:'Synthetic fixture only.'}],harness:redHarness.config,harnessHash:redHash,model:'gpt-6.1-sol',coverage:{complete:true,completedChunks:1,chunks:1,calls:2}};
  const base={role:'red',revision:'synthetic-red',fileHash:'f'.repeat(64),sourceHash:redSource,segments:redSegments,harness:redHarness.config,harnessHash:redHash,maxCalls:4,level:1,model:'gpt-6.1-sol',provenance:'local-codex',response,sourceName:'synthetic.txt',format:'TXT',requestId:'synthetic-red-exec',createdAt:'2026-10-26T00:00:00.000Z'};
  const root={...base,id:'root-run'};
  const selected=Red.patches({segments:redSegments},[{id:'c1',segmentId:'s0',before:redTexts[0],after:changed,edited:false,selected:true}]);
  const snap={...base,id:'snap-run',createdAt:'2026-10-26T00:01:00.000Z',finalState:{selected,outputFileHash:'a'.repeat(64),verification:{synthetic:true}},snapshotOf:root.id};
  const findings=blueSegments.map((s,i)=>({id:'F'+(i+1),segmentId:s.id,quote:s.text,rationale:'Synthetic finding '+(i+1)+'.',evidence:[{segmentId:s.id,quote:s.text.slice(0,20),relation:'Synthetic support.'}],uncertainty:'Synthetic only.'}));
  const blue={id:'blue-run',createdAt:'2026-10-26T00:02:00.000Z',role:'blue',revision:'synthetic-blue',fileHash:'a'.repeat(64),sourceHash:blueSource,segments:blueSegments,harness:blueHarness.config,harnessHash:blueHash,maxCalls:4,level:null,model:'manual-model-unverified',provenance:'manual-unverified',response:{schema:Blue.VERSION,revision:'synthetic-blue',sourceHash:blueSource,status:'ok',findings},sourceName:'synthetic-blue.txt',format:'TXT'};
  const planSelected=snap.finalState.selected.map(p=>({id:p.id,label:p.label,before:p.before,after:p.after}));
  const patches=Blue.validatePlan(blue,{schema:'falsify.document-edit-plan.v1',outputFileHash:blue.fileHash,selected:planSelected});
  const review={id:'review-1',runId:blue.id,createdAt:'2026-10-26T00:03:00.000Z',reviewer:'Synthetic reviewer',caseLabel:'Synthetic condition',verdict:'supported',score:4,note:'[검수 방식: RED 공개 대조 · 블라인드 아님]\nSynthetic overall note.',comparison:{outputFileHash:blue.fileHash,selected:planSelected,assessments:patches.map(p=>({id:p.id,verdict:'detected',note:'Synthetic matching conflict.',quoteOverlapFindingIds:Blue.overlaps(p,findings)})),sourceRunId:snap.id},findingAssessments:findings.map(f=>({id:f.id,verdict:'supported',note:'Synthetic source supports '+f.id+'.'})),reviewContext:{mode:'red-assisted'}};
  const laterSelected=Red.patches({segments:redSegments},[{id:'c1',segmentId:'s0',before:redTexts[0],after:'show benefit',edited:true,selected:true}]);
  const later={...base,id:'later-run',createdAt:'2026-10-26T00:04:00.000Z',provenance:'manual-unverified',model:'manual-model-unverified',requestId:'synthetic-red-later',finalState:{selected:laterSelected,outputFileHash:blue.fileHash,verification:null}};
  const otherSegments=[{id:'s0',label:'p1',text:'Unrelated synthetic sentence stays local.'}];
  const other={...base,id:'other-run',createdAt:'2026-10-26T00:05:00.000Z',revision:'synthetic-other',fileHash:'e'.repeat(64),sourceHash:await sha(otherSegments[0].text),segments:otherSegments,requestId:'synthetic-other',response:{...response,revision:'synthetic-other',sourceHash:await sha(otherSegments[0].text),candidates:[{...response.candidates[0],before:otherSegments[0].text,after:'Unrelated synthetic sentence leaves local.'}]},finalState:undefined,snapshotOf:undefined};
  delete other.finalState;delete other.snapshotOf;
  const snapshot={schema:LEDGER_SCHEMA,harnesses:[redHarness,blueHarness],runs:[root,snap,blue,later,other],reviews:[review]};
  return {snapshot,root,snap,blue,later,other,review};
}

test('experiment archive keeps the RED root, final, comparison source, later match and five item reviews',async()=>{
  const {snapshot,root,snap,blue,later,other,review}=await fiveCase();
  const before=canonicalJSON(snapshot);
  const archive=await buildExperimentArchive(snapshot,blue.id,V);
  assert.equal(canonicalJSON(snapshot),before);
  assert.equal(archive.schema,ARCHIVE_SCHEMA);assert.equal(archive.kind,'experiment');assert.equal(archive.id,blue.id);
  assert.equal(archive.data.schema,BUNDLE_SCHEMA);assert.equal(archive.data.selectedRunId,blue.id);
  assert.deepEqual(archive.data.ledger.runs.map(r=>r.id),[root.id,snap.id,blue.id,later.id]);
  assert.ok(!archive.data.ledger.runs.some(r=>r.id===other.id));
  assert.deepEqual(archive.data.ledger.harnesses.map(h=>h.hash).sort(),[root.harnessHash,blue.harnessHash].sort());
  const stored=archive.data.ledger.runs.find(r=>r.id===blue.id);
  assert.equal(stored.provenance,'manual-unverified');
  assert.deepEqual(stored.response,blue.response);
  assert.equal(archive.data.ledger.runs.find(r=>r.id===root.id).provenance,'local-codex');
  assert.equal(archive.data.ledger.runs.find(r=>r.id===snap.id).snapshotOf,root.id);
  assert.deepEqual(archive.data.ledger.runs.find(r=>r.id===snap.id).response,root.response);
  assert.equal(archive.data.ledger.reviews.length,1);
  assert.equal(archive.data.ledger.reviews[0].comparison.sourceRunId,snap.id);
  assert.equal(archive.data.ledger.reviews[0].findingAssessments.length,5);
  assert.equal(archive.data.ledger.reviews[0].reviewContext.mode,'red-assisted');
  assert.deepEqual(archive.data.ledger.reviews[0],review);
  const again=await validateArchive(archive,V);
  assert.equal(await archiveHash(archive),await archiveHash({title:archive.title,schema:archive.schema,data:archive.data,kind:archive.kind,id:archive.id}));
  assert.deepEqual(again.data.ledger.runs.find(r=>r.id===blue.id).response,blue.response);
  const tampered=structuredClone(archive);tampered.data.ledger.runs.find(r=>r.id===blue.id).response.findings[0].quote='This quote is not in the source.';
  assert.notEqual(await archiveHash(tampered),await archiveHash(archive));
  await assert.rejects(validateArchive(tampered,V),e=>e instanceof ReviewBundleError&&e.code==='malformed');
});

test('archive build rejects cycles, dangling parents, bad hashes and non-minimal or oversized envelopes',async()=>{
  const {snapshot,snap,blue}=await fiveCase();
  const cycle={...snapshot,runs:[{id:'a',snapshotOf:'b'},{id:'b',snapshotOf:'a'}]};
  await assert.rejects(buildExperimentArchive(cycle,'a',V),e=>e.code==='cycle');
  const dangling=structuredClone(snapshot);dangling.runs.find(r=>r.id===snap.id).snapshotOf='missing-root';
  await assert.rejects(buildExperimentArchive(dangling,blue.id,V),e=>e.code==='missing_ref');
  const hashed=await buildExperimentArchive(snapshot,blue.id,V);
  const badHash=structuredClone(hashed);badHash.data.ledger.runs[0].sourceHash='0'.repeat(64);
  await assert.rejects(validateArchive(badHash,V),e=>e.code==='hash_mismatch');
  const extra=structuredClone(hashed);extra.data.ledger.runs.push({id:'surplus'});
  await assert.rejects(validateArchive(extra,V),e=>e.code==='conflict'||e.code==='malformed'||e.code==='oversize');
  await assert.rejects(validateArchive({schema:'falsify.private-review-bundle.v1',selectedRunId:blue.id,ledger:snapshot},V),e=>e.code==='malformed');
  const huge={schema:ARCHIVE_SCHEMA,kind:'experiment',id:'x',title:'x',data:'x'.repeat(MAX_ARCHIVE_BYTES+1)};
  await assert.rejects(validateArchive(huge,V),e=>e.code==='oversize'&&!String(e.message).includes('x'.repeat(80)));
  const many={schema:ARCHIVE_SCHEMA,kind:'experiment',id:'run-0',title:'count',data:{schema:BUNDLE_SCHEMA,selectedRunId:'run-0',ledger:{schema:LEDGER_SCHEMA,harnesses:[],runs:Array.from({length:101},(_,i)=>({id:'run-'+i})),reviews:[]}}};
  await assert.rejects(validateArchive(many,V),e=>e.code==='oversize');
});

test('an imported snapshot may cite a local root with the same identity, and a conflicting parent is rejected',async()=>{
  const {snapshot,root,snap}=await fiveCase();
  const pair=structuredClone(snapshot);
  pair.runs=pair.runs.filter(r=>r.id===root.id||r.id===snap.id);
  pair.reviews=[];
  pair.harnesses=pair.harnesses.filter(h=>h.hash===root.harnessHash);
  pair.runs.find(r=>r.id===snap.id).provenance='imported-unverified';
  const archive=await buildExperimentArchive(pair,snap.id,V);
  assert.equal(archive.data.ledger.runs.find(r=>r.id===root.id).provenance,'local-codex');
  assert.equal(archive.data.ledger.runs.find(r=>r.id===snap.id).provenance,'imported-unverified');
  assert.deepEqual(archive.data.ledger.runs.find(r=>r.id===snap.id).response,root.response);
  assert.equal((await validateArchive(archive,V)).data.ledger.runs.find(r=>r.id===snap.id).snapshotOf,root.id);
  const manual=structuredClone(pair);manual.runs.find(r=>r.id===snap.id).provenance='manual-unverified';
  await assert.rejects(buildExperimentArchive(manual,snap.id,V),e=>e.code==='missing_ref');
  const reversed=structuredClone(pair);
  reversed.runs.find(r=>r.id===root.id).provenance='imported-unverified';
  reversed.runs.find(r=>r.id===snap.id).provenance='local-codex';
  await assert.rejects(buildExperimentArchive(reversed,snap.id,V),e=>e.code==='missing_ref');
  const forged=structuredClone(pair);
  const forgedRoot=forged.runs.find(r=>r.id===root.id);
  forgedRoot.response=structuredClone(forgedRoot.response);
  forgedRoot.response.candidates[0].rationale='Forged parent rationale.';
  await assert.rejects(buildExperimentArchive(forged,snap.id,V),e=>e.code==='missing_ref');
  const relinked=structuredClone(pair);
  const parent=relinked.runs.find(r=>r.id===root.id);
  parent.id='other-root';parent.requestId='synthetic-other-root';
  relinked.runs.find(r=>r.id===snap.id).snapshotOf='other-root';
  await assert.rejects(buildExperimentArchive(relinked,snap.id,V),e=>e.code==='missing_ref');
});

test('standalone harness archive validates the content hash and does not carry runs',async()=>{
  const config={...H.builtin('blue'),id:'archive-blue',name:'Archive BLUE'};
  const hash=await H.hash(config);
  const archive=await buildHarnessArchive({config,hash,parentHash:'ignored'},V);
  assert.deepEqual(Object.keys(archive.data).sort(),['config','hash']);
  assert.equal(archive.kind,'harness');assert.equal(archive.id,hash);assert.equal(archive.data.hash,hash);
  assert.equal((await validateArchive(archive,V)).id,hash);
  const tampered=structuredClone(archive);tampered.data.config.instructions+=' tamper';
  await assert.rejects(validateArchive(tampered,V),e=>e.code==='hash_mismatch');
  await assert.rejects(buildHarnessArchive({config,hash:'ab'.repeat(32)},V),e=>e.code==='hash_mismatch');
});
