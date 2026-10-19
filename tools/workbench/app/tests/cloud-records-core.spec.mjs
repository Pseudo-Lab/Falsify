// Node regression for the shared-records contract core: strict payload schemas, canonical harness hashes, public projection,
// local conversion and the controlled comparison. Synthetic records only; no network, server, CLI or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as C from '../dist/cloud-records-core.mjs';
const require=createRequire(import.meta.url),H=require('../dist/harness-core.js'),R=require('../dist/document-red-core.js');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const rejects=async(p,code)=>{await assert.rejects(Promise.resolve().then(p),e=>e instanceof C.CloudRecordError&&e.code===code&&!/secret|Synthetic/.test(e.message));};
const throwsCode=(f,code)=>assert.throws(f,e=>e instanceof C.CloudRecordError&&e.code===code);
const A='a'.repeat(64),B='b'.repeat(64),F='f'.repeat(64);
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'},{id:'s1',label:'p2',text:'Only an association was observed.'}];
async function localRun(over={}){const harness=H.builtin('red');return {id:'local-run-1',createdAt:'2026-10-19T01:02:03.000Z',role:'red',revision:'rev',fileHash:F,sourceHash:await sha(segments.map(s=>s.text).join('\n\n')),
  segments:segments.map(s=>({...s,page:1})),harness,harnessHash:await H.hash(harness),maxCalls:8,level:1,model:'gpt-6.1-sol',provenance:'local-codex',sourceName:'secret-paper.pdf',format:'PDF',
  response:{schema:R.VERSION,revision:'rev',sourceHash:'x',status:'abstain',candidates:[],coverage:{complete:false,completedChunks:1,chunks:2,calls:3}},...over};}
const runPayload=(over={})=>({localId:'l1',role:'red',harnessHash:A,sourceHash:B,fileHash:F,model:'gpt-6.1-sol',level:1,maxCalls:8,status:'ok',calls:4,provenance:'local-codex',createdAt:'2026-10-19T00:00:00.000Z',caseLabel:'case-1',protocolVersion:'falsify.document-red.v1',...over});
const reviewPayload=(over={})=>({runId:uuid(1),verdict:'supported',score:4,note:'Synthetic note.',caseLabel:'case-1',...over});
const P='falsify.document-red.v1';

test('harness payload: canonical H hash, key order free, strict fields, injected or global H',async()=>{
  const config={...H.builtin('blue'),id:'shared-blue'},hash=await H.hash(config),reordered=Object.fromEntries(Object.entries(config).reverse());
  assert.deepEqual(await C.validatePayload('harness',{config:reordered,hash},{harness:H}),{config:H.validate(config),hash});
  assert.equal((await C.validatePayload('harness',{config,hash,parentHash:A},{harness:H})).parentHash,A);
  await rejects(()=>C.validatePayload('harness',{config:{...config,instructions:'changed'},hash},{harness:H}),'harness_hash_mismatch');
  await rejects(()=>C.validatePayload('harness',{config,hash,extra:1},{harness:H}),'invalid_payload');
  await rejects(()=>C.validatePayload('harness',{config,hash,parentHash:'XYZ'},{harness:H}),'invalid_payload');
  await rejects(()=>C.validatePayload('harness',{config,hash,parentHash:hash},{harness:H}),'invalid_payload');
  await rejects(()=>C.validatePayload('harness',{config:{...config,schema:'other'},hash},{harness:H}),'invalid_payload');
  await rejects(()=>C.validatePayload('harness',{config,hash},{harness:null}),'harness_unavailable');
  await rejects(()=>C.validatePayload('gold',{}),'unsupported_kind');
  globalThis.FalsifyHarness=H;try{assert.equal((await C.validatePayload('harness',{config,hash})).hash,hash);}finally{delete globalThis.FalsifyHarness;}
  await rejects(()=>C.validatePayload('harness',{config,hash}),'harness_unavailable');});

test('run payload: strict schema, every status, bounded fields, denied fields',async()=>{
  for(const status of C.RUN_STATUSES)assert.equal((await C.validatePayload('run',runPayload({status}))).status,status);
  assert.equal((await C.validatePayload('run',runPayload({role:'blue',level:null,calls:null}))).calls,null);
  const minimal=runPayload();delete minimal.caseLabel;delete minimal.protocolVersion;assert.deepEqual(await C.validatePayload('run',minimal),minimal);
  for(const bad of [{sourceName:'secret.pdf'},{authorId:'x'},{owner:{id:'x'}},{verified:true},{status:'success'},{role:'gold'},{role:'blue',level:1},{level:4},{level:null},{maxCalls:0},{maxCalls:33},{calls:-1},{calls:1.5},
    {harnessHash:'A'.repeat(64)},{sourceHash:'short'},{fileHash:null},{model:''},{model:'m\nx'},{model:'m'.repeat(121)},{provenance:'verified'},{createdAt:'yesterday'},{createdAt:'2026-13-45T00:00:00Z'},
    {caseLabel:'c'.repeat(161)},{caseLabel:' '},{protocolVersion:'p'.repeat(81)},{localId:''}])
    await rejects(()=>C.validatePayload('run',runPayload(bad)),'invalid_payload');
  const missing=runPayload();delete missing.calls;await rejects(()=>C.validatePayload('run',missing),'invalid_payload');
  await rejects(()=>C.validatePayload('run',[runPayload()]),'invalid_payload');
  await rejects(()=>C.validatePayload('run',runPayload({caseLabel:'x'.repeat(C.LIMITS.payload)})),'payload_too_large');});

test('run evidence: private, strict, bounded and bound to sourceHash',async()=>{
  const sourceHash=await sha(segments.map(s=>s.text).join('\n\n')),evidence={segments,response:{status:'ok'}};
  const ok=await C.validatePayload('run',runPayload({sourceHash,evidence:{...evidence,finalState:{selected:[]}}}));assert.deepEqual(ok.evidence.segments,segments);
  await rejects(()=>C.validatePayload('run',runPayload({evidence})),'invalid_payload');
  for(const bad of [{...evidence,sourceName:'x'},{...evidence,segments:[]},{...evidence,segments:[{...segments[0],page:1}]},{...evidence,segments:[segments[0],segments[0]]},{...evidence,response:[]},{...evidence,finalState:'x'},{segments}])
    await rejects(()=>C.validatePayload('run',runPayload({sourceHash,evidence:bad})),'invalid_payload');
  await rejects(()=>C.validatePayload('run',runPayload({sourceHash,evidence:{...evidence,response:{blob:'x'.repeat(C.LIMITS.evidence)}}})),'payload_too_large');});

test('review payload: verdicts, uncertain score null, bounded note, no reviewer identity fields',async()=>{
  for(const verdict of C.VERDICTS)await C.validatePayload('review',reviewPayload({verdict,score:verdict==='uncertain'?null:3}));
  assert.equal((await C.validatePayload('review',reviewPayload({score:null,protocolVersion:'p1',supersedes:uuid(9),note:'line1\nline2'}))).supersedes,uuid(9));
  for(const bad of [{verdict:'uncertain',score:2},{score:0},{score:6},{score:2.5},{verdict:'gold'},{runId:'local-run-1'},{note:''},{note:'n'.repeat(3001)},{caseLabel:''},{supersedes:'x'},
    {reviewer:'Synthetic reviewer'},{authorId:uuid(2)},{comparison:null}])
    await rejects(()=>C.validatePayload('review',reviewPayload(bad)),'invalid_payload');});

test('public projection never carries evidence, localId or unknown fields',async()=>{
  const sourceHash=await sha(segments.map(s=>s.text).join('\n\n')),stored=await C.validatePayload('run',runPayload({sourceHash,evidence:{segments,response:{status:'ok',secret:'s'}}}));
  const pub=C.publicPayload('run',{...stored,sourceName:'secret.pdf',reviewer:'x'});
  assert.deepEqual(Object.keys(pub).sort(),[...C.PUBLIC_FIELDS.run].sort());assert.ok(!('evidence' in pub)&&!('localId' in pub));assert.doesNotMatch(JSON.stringify(pub),/secret|Study|association/);
  pub.caseLabel='mutated';assert.equal(stored.caseLabel,'case-1','projection is a copy');
  assert.deepEqual(C.publicPayload('review',{...reviewPayload(),reviewer:'x'}),reviewPayload());
  const config=H.builtin('red');assert.deepEqual(C.publicPayload('harness',{config,hash:A,extra:1}),{config,hash:A});
  throwsCode(()=>C.publicPayload('gold',{}),'unsupported_kind');});

test('runFromLocal: outcome through H, evidence only on explicit true, snapshots refused',async()=>{
  const run=await localRun(),p=C.runFromLocal(run,{harness:H,caseLabel:'case-1'});
  assert.deepEqual(p,{localId:'local-run-1',role:'red',harnessHash:run.harnessHash,sourceHash:run.sourceHash,fileHash:F,model:'gpt-6.1-sol',level:1,maxCalls:8,status:'abstain',calls:3,provenance:'local-codex',createdAt:run.createdAt,caseLabel:'case-1',protocolVersion:R.VERSION});
  assert.doesNotMatch(JSON.stringify(p),/secret-paper|Study|PDF/);
  for(const includeEvidence of [false,'true',1,undefined])assert.ok(!('evidence' in C.runFromLocal(run,{harness:H,includeEvidence})));
  const withEvidence=C.runFromLocal(run,{harness:H,includeEvidence:true});assert.deepEqual(withEvidence.evidence.segments,segments,'segments projected to id/label/text');
  assert.deepEqual(await C.validatePayload('run',withEvidence),withEvidence);
  const manual=C.runFromLocal({...run,provenance:'manual-unverified',model:'manual-model-unverified'},{harness:H});assert.equal(manual.calls,null,'manual coverage claims are not counted');assert.equal(manual.status,'abstain');
  assert.equal(C.runFromLocal({...run,response:{...run.response,status:'weird'}},{harness:H}).status,'unknown');
  const noH=C.runFromLocal(run,{harness:null});assert.equal(noH.status,'abstain');assert.equal(noH.calls,3);
  assert.equal(C.runFromLocal({...run,provenance:'imported-unverified'},{harness:null}).calls,null);
  assert.equal(C.runFromLocal(run,{harness:H,protocolVersion:'custom-protocol'}).protocolVersion,'custom-protocol');
  const blue=C.runFromLocal({...run,role:'blue',level:null},{harness:H});assert.equal(blue.level,null);
  throwsCode(()=>C.runFromLocal({...run,snapshotOf:'local-run-0'},{harness:H}),'invalid_payload');
  throwsCode(()=>C.runFromLocal({...run,harnessHash:'bad'},{harness:H}),'invalid_payload');});

test('reviewFromLocal drops the typed reviewer label, comparison and local IDs',()=>{
  const local={id:'local-review',runId:'local-run-1',createdAt:'2026-10-19T00:00:00.000Z',reviewer:'Dr. Synthetic',caseLabel:'case-1',verdict:'uncertain',score:null,note:'Synthetic note.',comparison:{assessments:[]}};
  const p=C.reviewFromLocal(local,uuid(5),{protocolVersion:R.VERSION});
  assert.deepEqual(p,{runId:uuid(5),verdict:'uncertain',score:null,note:'Synthetic note.',caseLabel:'case-1',protocolVersion:R.VERSION});assert.doesNotMatch(JSON.stringify(p),/Dr\. Synthetic|local-review|assessments/);
  throwsCode(()=>C.reviewFromLocal(local,'local-run-1'),'invalid_payload');throwsCode(()=>C.reviewFromLocal({...local,verdict:'supported',score:9},uuid(5)),'invalid_payload');});

test('payloadHash is canonical over key order',async()=>{
  const a=runPayload(),b=Object.fromEntries(Object.entries(a).reverse());assert.equal(await C.payloadHash('run',a),await C.payloadHash('run',b));
  assert.notEqual(await C.payloadHash('run',a),await C.payloadHash('run',runPayload({calls:5})));assert.match(await C.payloadHash('run',a),/^[a-f0-9]{64}$/);});

// Server-shaped records: owner is the server author, payload already projected for shared reads.
let seq=0;const rec=(kind,payload,owner='author-a',over={})=>({id:over.id||uuid(++seq+100),owner:{id:owner,displayName:'Self '+owner},kind,visibility:'shared',createdAt:over.createdAt||'2026-10-19T00:00:'+String(seq).padStart(2,'0')+'.000Z',updatedAt:'2026-10-19T00:00:00.000Z',revision:over.revision||1,payload,attestation:'client-reported'});
function fixture(){seq=0;const runs={},list=[];const add=r=>{list.push(r);return r;};
  add(rec('harness',{config:H.builtin('red'),hash:A}));
  for(const [name,payload,owner] of [['a-ok',runPayload({harnessHash:A,status:'ok',calls:4}),'author-a'],['a-fail',runPayload({harnessHash:A,status:'failed',calls:null}),'author-a'],['a-cancel',runPayload({harnessHash:A,status:'cancelled',calls:1}),'author-a'],
    ['b-ok',runPayload({harnessHash:B,status:'ok',calls:2}),'author-b'],['b-refusal',runPayload({harnessHash:B,status:'refusal',calls:null}),'author-b'],['b-manual',runPayload({harnessHash:B,status:'ok',provenance:'manual-unverified',model:'gpt-6.1-sol',calls:null}),'author-b'],
    ['other-case',runPayload({harnessHash:A,caseLabel:'case-2'}),'author-a'],['no-protocol',(()=>{const p=runPayload({harnessHash:A});delete p.protocolVersion;return p;})(),'author-a']]){
    const p={...payload};delete p.localId;runs[name]=add(rec('run',p,owner));}
  const review=(run,owner,over,meta)=>add(rec('review',reviewPayload({runId:runs[run].id,protocolVersion:P,...over}),owner,meta));
  review('a-ok','author-r1',{score:2},{createdAt:'2026-10-19T01:00:00.000Z'});review('a-ok','author-r1',{score:5},{createdAt:'2026-10-19T02:00:00.000Z'});
  review('a-ok','author-r2',{verdict:'uncertain',score:null},{createdAt:'2026-10-19T01:30:00.000Z'});review('a-fail','author-r2',{score:3},{createdAt:'2026-10-19T01:30:00.000Z'});
  review('b-ok','author-r1',{score:1});review('b-manual','author-r1',{score:5});
  add(rec('review',reviewPayload({runId:uuid(999)}),'author-r1'));add({id:'broken',kind:'run',payload:{}});add(rec('run',runPayload({status:'success'}),'author-a'));
  return {runs,list};}
const groupFor=(out,caseLabel)=>out.groups.find(g=>g.conditions.caseLabel===caseLabel);

test('compareRecords: same conditions only, harnesses side by side, origins never mixed, all outcomes counted',()=>{
  const {runs,list}=fixture(),out=C.compareRecords(list),g=groupFor(out,'case-1');
  assert.deepEqual(Object.keys(out).sort(),['groups','warnings']);assert.equal(out.groups.length,2,'case-2 is its own group');
  assert.deepEqual(g.conditions,{sourceHash:B,role:'red',model:'gpt-6.1-sol',level:1,maxCalls:8,protocolVersion:'falsify.document-red.v1',caseLabel:'case-1'});assert.equal(g.attestation,'client-reported');assert.equal(g.runCount,6);
  assert.deepEqual(g.harnesses.map(h=>[h.hash.slice(0,1),h.origin]),[['a','executed'],['b','executed'],['b','manual']]);
  const [a,b,manual]=g.harnesses;
  assert.deepEqual(a.statuses,{ok:1,abstain:0,refusal:0,failed:1,cancelled:1,unknown:0});assert.deepEqual(b.statuses,{ok:1,abstain:0,refusal:1,failed:0,cancelled:0,unknown:0});
  assert.equal(a.harnessAvailable,true);assert.equal(b.harnessAvailable,false);
  assert.deepEqual([a.calls,a.callsUnknown],[5,1],'unknown cost stays unknown, never zero');assert.deepEqual([b.calls,b.callsUnknown],[2,1]);
  assert.deepEqual(a.runIds,[runs['a-ok'].id,runs['a-fail'].id,runs['a-cancel'].id].sort());});

test('compareRecords: latest review per run and server owner, uncertain excluded from means, manual means hidden',()=>{
  const out=C.compareRecords(fixture().list),[a,b,manual]=groupFor(out,'case-1').harnesses;
  assert.deepEqual({reviewCount:a.reviewCount,uncertainCount:a.uncertainCount,scoreCount:a.scoreCount,scoreMean:a.scoreMean,reviewerCount:a.reviewerCount},{reviewCount:3,uncertainCount:1,scoreCount:2,scoreMean:4,reviewerCount:2},'r1 latest 5 replaces 2; r2 uncertain excluded; r2 on a-fail 3');
  assert.equal(b.scoreMean,1);assert.equal(manual.scoreMean,null);assert.equal(manual.scoreCount,1);});

test('compareRecords: warnings explain client-reported limits, missing references and incomparable runs',()=>{
  const {runs,list}=fixture(),out=C.compareRecords(list),codes=Object.fromEntries(out.warnings.map(w=>[w.code,w]));
  assert.deepEqual(Object.keys(codes),['client_reported','harness_definition_missing','incomparable_missing_condition','invalid_record','review_run_missing']);
  assert.match(codes.client_reported.message,/client-reported/);assert.match(codes.client_reported.message,/not accuracy/);assert.match(codes.client_reported.message,/never causal/);
  assert.deepEqual(codes.incomparable_missing_condition.recordIds,[runs['no-protocol'].id]);assert.ok(codes.harness_definition_missing.recordIds.includes(runs['b-ok'].id));
  assert.equal(codes.invalid_record.recordIds.length,2,'broken shape and an invalid status');
  assert.doesNotMatch(JSON.stringify(out),/Study does not|Self author/);});

test('compareRecords: an owner (scope mine) record is compared through its public projection',()=>{
  const {list}=fixture(),mine=rec('run',runPayload({harnessHash:A,status:'abstain',evidence:{segments,response:{secret:'s'}}}),'author-a'),out=C.compareRecords([...list,mine]);
  const a=groupFor(out,'case-1').harnesses[0];assert.equal(a.statuses.abstain,1);assert.ok(a.runIds.includes(mine.id));assert.doesNotMatch(JSON.stringify(out),/secret|Study|"l1"/);});

test('compareRecords: deterministic over input order and duplicate revisions',()=>{
  const {list}=fixture(),base=C.compareRecords(list),shuffled=[...list].reverse();
  assert.deepEqual(C.compareRecords(shuffled),base);
  const run=list.find(r=>r.kind==='run'),newer={...run,revision:2,payload:{...run.payload,status:'unknown'}};
  const out=C.compareRecords([newer,...list]),entry=groupFor(out,'case-1').harnesses[0];assert.equal(entry.statuses.unknown,1);assert.equal(entry.runCount,3,'one record per id');
  assert.deepEqual(C.compareRecords([]),{groups:[],warnings:[]});assert.deepEqual(C.compareRecords(null),{groups:[],warnings:[]});});

test('compareRecords: cross-owner supersedes is ignored with a warning',()=>{
  const {runs,list}=fixture(),first=list.find(r=>r.kind==='review'),other=rec('review',reviewPayload({runId:runs['a-ok'].id,protocolVersion:P,supersedes:first.id,score:1}),'author-r3');
  const out=C.compareRecords([...list,other]);assert.deepEqual(out.warnings.find(w=>w.code==='review_supersedes_other_owner').recordIds,[other.id]);
  assert.equal(groupFor(out,'case-1').harnesses[0].reviewCount,4,'r1 latest still counted; r3 counted separately');});

const reviewStats=e=>({reviewCount:e.reviewCount,uncertainCount:e.uncertainCount,scoreCount:e.scoreCount,scoreMean:e.scoreMean,reviewerCount:e.reviewerCount});
const MISMATCH='Reviews whose case label or protocol version is missing or differs from the reviewed run were left out of review counts and means.';

test('compareRecords: reviews count only when their case label and protocol version exactly match the run',()=>{
  const {runs,list}=fixture(),base=groupFor(C.compareRecords(list),'case-1').harnesses[0],later={createdAt:'2026-10-19T09:00:00.000Z'};
  assert.deepEqual(reviewStats(base),{reviewCount:3,uncertainCount:1,scoreCount:2,scoreMean:4,reviewerCount:2},'valid mean unchanged by the matching rule');
  const onA=(over,owner)=>rec('review',reviewPayload({runId:runs['a-ok'].id,protocolVersion:P,...over}),owner,later);
  const noProtocol=rec('review',reviewPayload({runId:runs['a-ok'].id,score:1}),'author-r4',later);
  const extra=[noProtocol,onA({caseLabel:'case-2',score:1},'author-r5'),onA({protocolVersion:'p9',score:1},'author-r6'),onA({caseLabel:'Case-1',score:1},'author-r7'),
    onA({protocolVersion:'p9',score:1},'author-r1'),rec('review',reviewPayload({runId:runs['no-protocol'].id,protocolVersion:P,score:1}),'author-r1')];
  const input=[...list,...extra],before=JSON.stringify(input),out=C.compareRecords(input),a=groupFor(out,'case-1').harnesses[0];
  assert.deepEqual(reviewStats(a),reviewStats(base),'missing/mismatched excluded; the newer mismatched r1 review does not hide the older matching one');
  const w=out.warnings.find(x=>x.code==='review_condition_mismatch');
  assert.deepEqual(w,{code:'review_condition_mismatch',message:MISMATCH,recordIds:extra.map(r=>r.id).sort()});
  assert.equal(JSON.stringify(input),before,'records are kept as they are, never rewritten or dropped from the data');
  assert.deepEqual(C.compareRecords([...input].reverse()),out,'deterministic over input order');});

test('compareRecords: a newer matching uncertain review still removes that owner score from the mean',()=>{
  const {runs,list}=fixture(),uncertain=rec('review',reviewPayload({runId:runs['a-ok'].id,protocolVersion:P,verdict:'uncertain',score:null}),'author-r1',{createdAt:'2026-10-19T09:00:00.000Z'});
  const a=groupFor(C.compareRecords([...list,uncertain]),'case-1').harnesses[0];
  assert.deepEqual(reviewStats(a),{reviewCount:3,uncertainCount:2,scoreCount:1,scoreMean:3,reviewerCount:2},'r1 latest is uncertain; only r2 on a-fail scores');});

test('reviewFromLocal: protocolVersion stays optional for storage, nothing is backfilled, and such a review is not aggregated',async()=>{
  const {runs,list}=fixture(),local={id:'local-review',runId:'local-run-1',createdAt:'2026-10-19T00:00:00.000Z',reviewer:'Dr. Synthetic',caseLabel:'case-1',verdict:'supported',score:1,note:'Synthetic note.'};
  const p=C.reviewFromLocal(local,runs['a-ok'].id);assert.ok(!('protocolVersion' in p),'no protocol is invented');assert.deepEqual(await C.validatePayload('review',p),p);
  const r=rec('review',p,'author-r8'),out=C.compareRecords([...list,r]);
  assert.equal(groupFor(out,'case-1').harnesses[0].scoreMean,4);assert.deepEqual(out.warnings.find(x=>x.code==='review_condition_mismatch').recordIds,[r.id]);});

test('64-hex hash fields reject non-string values that a regular expression test would coerce',async()=>{
  for(const field of ['harnessHash','sourceHash','fileHash'])for(const bad of [[A],[],64,null,{}])
    await rejects(()=>C.validatePayload('run',runPayload({[field]:bad})),'invalid_payload');
  const config=H.builtin('red'),hash=await H.hash(config);
  for(const bad of [[hash],[],1,null,{}]){await rejects(()=>C.validatePayload('harness',{config,hash:bad},{harness:H}),'invalid_payload');
    await rejects(()=>C.validatePayload('harness',{config,hash,parentHash:bad},{harness:H}),'invalid_payload');}
  const strip=({localId,...p})=>p,run=rec('run',strip(runPayload({harnessHash:A}))),arrayRun=rec('run',strip(runPayload({harnessHash:[A]}))),arrayHarness=rec('harness',{config,hash:[A]});
  const out=C.compareRecords([run,arrayRun,arrayHarness]),[entry]=out.groups[0].harnesses;
  assert.deepEqual(out.warnings.find(w=>w.code==='invalid_record').recordIds,[arrayRun.id,arrayHarness.id].sort());
  assert.equal(out.groups[0].harnesses.length,1);assert.equal(entry.runCount,1,'an array hash is never merged with the string hash');assert.equal(entry.harnessAvailable,false);});

test('single-line labels reject bidi and invisible format characters; ISO dates are calendar-checked',async()=>{
  for(const bad of ['case\u{202e}A','case\u{200b}','\u{2066}case\u{2069}','case\u{feff}','case\u{2028}x','case\u{85}x','case\u{ad}','case\u{61c}']){
    await rejects(()=>C.validatePayload('run',runPayload({caseLabel:bad})),'invalid_payload');await rejects(()=>C.validatePayload('review',reviewPayload({caseLabel:bad})),'invalid_payload');}
  for(const bad of [{model:'\u{200f}gpt'},{protocolVersion:'p\u{202a}1'},{localId:'l\u{2060}1'}])await rejects(()=>C.validatePayload('run',runPayload(bad)),'invalid_payload');
  for(const ok of ['사례 1','caso-ñ','\u{1f469}\u{200d}\u{1f52c} lab','\u{645}\u{6cc}\u{200c}\u{62e}'])assert.equal((await C.validatePayload('run',runPayload({caseLabel:ok}))).caseLabel,ok,'ZWJ/ZWNJ and ordinary scripts stay valid');
  for(const ok of ['2024-02-29T00:00:00Z','2026-10-19T09:30:00+09:00','2026-10-19T09:30-05:30','2026-12-31T23:59:59.999999999Z','2026-10-19T00:00:00.000+14:00','2026-10-19T01:02:03.000Z'])
    assert.equal((await C.validatePayload('run',runPayload({createdAt:ok}))).createdAt,ok);
  for(const bad of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-10T00:00:00Z','2026-10-00T00:00:00Z','2026-10-19T24:00:00Z','2026-10-19T10:60:00Z','2026-10-19T10:00:60Z',
    '2026-10-19T10:00:00+24:00','2026-10-19T10:00:00+09:60',['2026-10-19T00:00:00Z']])
    await rejects(()=>C.validatePayload('run',runPayload({createdAt:bad})),'invalid_payload');});

let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
console.log(JSON.stringify({passed,total:tests.length}));if(passed!==tests.length)process.exit(1);
