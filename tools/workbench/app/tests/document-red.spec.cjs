'use strict';
const assert=require('node:assert/strict'),C=require('../dist/document-red-core.js');
const doc={revision:'r1',sourceHash:'h1',segments:[{id:'s0',label:'p1',text:'Study does not show benefit. Only an association was observed.'}]};
const candidate={id:'c1',segmentId:'s0',level:1,before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Negates the source limitation.',evidence:[{segmentId:'s0',quote:'Only an association was observed.',relation:'No causal proof.'}],uncertainty:'Needs domain review.'};
const response=c=>({schema:C.VERSION,revision:'r1',sourceHash:'h1',status:'ok',candidates:c});let checks=0;
function test(name,fn){fn();checks++;console.log('PASS '+name);}
test('validated proposals start unchecked',()=>assert.equal(C.validateResponse(doc,response([candidate]))[0].selected,false));
test('stale revision denied',()=>assert.throws(()=>C.validateResponse(doc,{...response([candidate]),revision:'old'})));
test('stale hash denied',()=>assert.throws(()=>C.validateResponse(doc,{...response([candidate]),sourceHash:'old'})));
test('fabricated quote denied',()=>assert.throws(()=>C.validateResponse(doc,response([{...candidate,evidence:[{...candidate.evidence[0],quote:'fabricated'}]}]))));
test('fabricated location denied',()=>assert.throws(()=>C.validateResponse(doc,response([{...candidate,segmentId:'missing'}]))));
test('duplicate ids denied',()=>assert.throws(()=>C.validateResponse(doc,response([candidate,candidate]))));
test('ambiguous target denied',()=>assert.throws(()=>C.validateResponse({...doc,segments:[{id:'s0',label:'p1',text:doc.segments[0].text+' '+candidate.before}]},response([candidate]))));
test('number changes allowed',()=>assert.equal(C.validateAfter('N=12','N=13'),'N=13'));
test('citation changes and deletions allowed',()=>{assert.equal(C.validateAfter('No [1]','Yes [2]'),'Yes [2]');assert.equal(C.validateAfter('text',''),'');});
test('unchanged candidate denied',()=>assert.throws(()=>C.validateAfter('same','same')));
test('refusal cannot contain candidates',()=>assert.throws(()=>C.validateResponse(doc,{...response([candidate]),status:'refusal'})));
test('empty abstain is legitimate',()=>assert.deepEqual(C.validateResponse(doc,{...response([]),status:'abstain'}),[]));
test('selected-only patch plan',()=>{const c=C.validateResponse(doc,response([candidate]));assert.throws(()=>C.patches(doc,c));c[0].selected=true;assert.equal(C.patches(doc,c).length,1);});
test('edited empty after denied',()=>assert.throws(()=>C.patches(doc,[{...candidate,selected:true,after:' '}])));
test('overlapping candidates denied',()=>assert.throws(()=>C.patches(doc,[{...candidate,selected:true},{...candidate,id:'c2',before:'does not show',after:'does show',selected:true}])));
test('Korean explanations are the default; exact paper text is not translated',()=>{const r=C.request(doc,2,8);assert.equal(r.explanationLanguage,'ko');assert.match(r.instructions,/in Korean/);assert.match(r.instructions,/never translate exact source/);assert.deepEqual(r.segments,doc.segments);});
test('English explanations can be selected explicitly',()=>{assert.equal(C.request(doc,2,8,'en').explanationLanguage,'en');assert.match(C.request(doc,2,8,'en').instructions,/in English/);assert.throws(()=>C.request(doc,2,8,'unknown'));});

console.log(JSON.stringify({passed:checks}));

test('mixed attack types and optional uncertainty',()=>{const c={...candidate,attackTypes:['contradiction','unsupported-inference'],after:'',uncertainty:undefined};delete c.level;assert.deepEqual(C.validateResponse(doc,response([c]))[0].attackTypes,c.attackTypes);assert.deepEqual(C.request(doc,c.attackTypes,8).attackTypes,c.attackTypes);});
