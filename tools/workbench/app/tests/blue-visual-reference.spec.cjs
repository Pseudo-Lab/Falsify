const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../dist/document-blue-core.js');
const doc={revision:'r',sourceHash:'a'.repeat(64),segments:[{id:'s0',text:'Synthetic',label:'p1'}]};
const request={visualEvidence:[{sha256:'b'.repeat(64),page:1,bbox:[0,0,10,10]}]};
const observation={id:'v1',sha256:'b'.repeat(64),page:1,bbox:[0,0,10,10],observation:'Figure',uncertainty:'Unverified'};
const response={schema:C.VERSION,revision:'r',sourceHash:doc.sourceHash,status:'ok',findings:[],visualObservations:[observation]};
test('visual reference binds frozen request and rejects stale or forged references',()=>{assert.deepEqual(C.validateResponse(doc,response,request),[]);assert.throws(()=>C.validateResponse(doc,response));assert.throws(()=>C.validateResponse(doc,{...response,visualObservations:[{...observation,page:2}]},request));assert.throws(()=>C.validateResponse(doc,{...response,visualObservations:[{...observation,sha256:'c'.repeat(64)}]},request));});
