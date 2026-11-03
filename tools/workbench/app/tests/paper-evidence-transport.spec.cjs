const test = require('node:test');
const assert = require('node:assert/strict');
const Bridge = require('../dist/local-bridge.js');
const Pending = require('../dist/pending-job.js');
const Harness = require('../dist/harness-core.js');
const Comparison = require('../dist/harness-comparison.js');

test('evidence routes use the existing authenticated bridge, with no arbitrary operation route', async () => {
  const requests = [];
  const bridge = Bridge.create({location: {hostname:'shinick-han.github.io'}, fetch: async (url, options) => {
    requests.push({url, options});
    return {ok:true, status:200, json:async()=>requests.length===1?{red:true,blue:true,pdf:true,paperEvidence:{available:true,schema:'falsify.paper-evidence.v1'}}:{paperId:'selected-paper'}};
  }});
  await bridge.ready;
  await bridge.pair('synthetic-test-credential-123456', '7816');
  assert.equal(bridge.capabilities().paperEvidence.available, true);
  for (const route of ['prepare','query']) {
    await bridge.session().request('/api/paper/evidence/'+route, {paperId:'selected-paper'});
    assert.equal(requests.at(-1).options.method, 'POST');
    assert.equal(requests.at(-1).options.credentials, 'omit');
    assert.ok(requests.at(-1).options.headers.Authorization.startsWith('Bearer '));
  }
  await assert.rejects(bridge.session().request('/api/paper/evidence/write', {}));
  assert.equal(requests.length, 3);
});

test('pending BLUE keeps only the source-bound handle and rejects invented cells', async () => {
  const saved = new Map();
  const storage = {getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const doc = {revision:'evidence-r1',sourceHash:'a'.repeat(64),fileHash:'b'.repeat(64),format:'PDF',name:'test.pdf',segments:[{id:'s0',label:'p1',text:'Example source.'}]};
  const request = {schema:'falsify.document-blue.v1',revision:doc.revision,requestId:'evidence-r1:request1',sourceHash:doc.sourceHash,segments:doc.segments,maxCalls:1,consent:true,harness:Harness.builtin('blue'),paperEvidence:{paperId:'selected-paper',fileHash:doc.fileHash},paperEvidenceConsent:true,fileHash:doc.fileHash};
  const options = {role:'blue',doc,request,storage,companionInstance:'ci1.'+'c'.repeat(64),hashHarness:Harness.hash,lockProvider:{request:async(_name,fn)=>fn()}};
  const held = await Pending.hold(options);
  assert.equal(held.ok, true);
  assert.equal(Pending.read('blue',storage).record.request.paperEvidence.paperId,'selected-paper');
  for (const paperEvidence of [{...request.paperEvidence,cells:[]},{...request.paperEvidence,fileHash:'d'.repeat(64)}]) {
    const result = await Pending.hold({...options,storage:{...storage,getItem:()=>null},request:{...request,paperEvidence}});
    assert.equal(result.ok,false);
  }
});

test('structured delivery is not pooled with text-only reviews', () => {
  const common = {role:'blue',sourceHash:'a'.repeat(64),fileHash:'b'.repeat(64),provenance:'local-codex',model:'known-model',maxCalls:1,level:null,harness:{settings:{comparisonRubric:'v1',portableStrategy:{schema:'falsify.portable-strategy.v1',name:'blue',version:'1',parameters:{}}}}};
  assert.ok(Comparison.differences({...common,inputMode:'text'},{...common,inputMode:'structured'}).some(s=>s.includes('입력 방식')));
});
