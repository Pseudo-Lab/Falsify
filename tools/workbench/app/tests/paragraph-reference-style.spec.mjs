import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planInlineChange} from '../src/paragraph-vendor/inline-preservation.mjs';
const run=(text,rgba,other={})=>({text,family:'Times LT Std',size:8,rise:4.483,hScale:1,rgba,...other});
function plan(runs,after='35') {const chars=runs.flatMap((r,ri)=>Array.from(r.text,(ch,o)=>({ch,pi:0,ri,o})));return planInlineChange([{runs}],chars,chars.map((_,i)=>[i,i]),0,chars.map(c=>c.ch).join(''),after);}
test('consolidating colored citation digits uses their common raised style',()=>{
 const p=plan([run('2',65535),run(',',255),run('3',65535)]);
 assert.equal(p.failure,undefined);assert.deepEqual(p.inserts,[{pi:0,ri:0,o:0,text:'35'}]);assert.equal(p.del.length,3);assert.equal(p.warning,'numeric_marker_style_from_digits');
});
test('link separator rule supports a numeric range without flattening surrounding text',()=>{
 const p=plan([run('See ',255),run('2',65535),run('–',255),run('3',65535),run(' for details.',255)],'See 35 for details.');
 assert.equal(p.failure,undefined);assert.deepEqual(p.inserts,[{pi:0,ri:1,o:0,text:'35'}]);assert.deepEqual(p.del.map(c=>c.ch),['2','–','3']);
});
test('different digit styles or true font/geometry changes remain unresolved',()=>{
 for(const runs of [[run('2',65535),run(',',255),run('3',255)],[run('2',65535),run(',',255,{size:10}),run('3',65535)],[run('2',65535),run(',',255,{rise:0}),run('3',65535)],[run('2',65535),run(',',255,{family:'Other'}),run('3',65535)]])assert.equal(plan(runs).failure,'AMBIGUOUS_STYLE');
});
test('mixed prose and newly punctuated alternatives do not assume a marker style',()=>{
 assert.equal(plan([run('item2',65535),run(',',255),run('3',65535)]).failure,'AMBIGUOUS_STYLE');
 assert.equal(plan([run('2',65535),run(',',255),run('3',65535)],'3,5').failure,'AMBIGUOUS_STYLE');
});

test('editing a raised digit inside an author word preserves the surrounding mixed styles',()=>{
 const runs=[run('Example Author ',255,{size:12,rise:0,bold:true}),run('Kim',255,{size:12,rise:0,bold:true}),run('2',65535),run(',',255),run('3',65535),run(', Other Author',255,{size:12,rise:0,bold:true})];
 const p=plan(runs,'Example Author Kim2,45, Other Author');
 assert.equal(p.failure,undefined);
 assert.deepEqual(p.del.map(c=>c.ch),['3']);
 assert.deepEqual(p.inserts,[{pi:0,ri:4,o:0,text:'45'}]);
 assert.deepEqual(p.numericMarker,{before:'3',after:'45',context:'Kim2,3,',offset:5});
});

test('a changed span crossing distinct styles still requires a mapping',()=>{
 const p=plan([run('Kim',255,{size:12,rise:0,bold:true}),run('2',65535),run(',',255),run('3',65535)],'Smith45');
 assert.equal(p.failure,'AMBIGUOUS_STYLE');
});

test('adding digits inside a mixed-style word keeps the existing numeric style',()=>{
 const runs=[run('Kim',255,{size:12,rise:0,bold:true}),run('2',65535),run(',',255),run('3',65535),run(',',255,{size:12,rise:0})];
 for(const after of ['Kim2,34,','Kim2,63,']){
  const p=plan(runs,after);
  assert.equal(p.failure,undefined);
  assert.deepEqual(p.del.map(c=>c.ch),['3']);
  assert.deepEqual(p.inserts,[{pi:0,ri:3,o:0,text:after==='Kim2,34,'?'34':'63'}]);
  assert.equal(p.numericMarker.before,'3');
  assert.equal(p.numericMarker.offset,5);
 }
});

test('numeric insertion spanning differently styled digits remains unresolved',()=>{
 const p=plan([run('Kim',255,{size:12,rise:0}),run('1',65535),run('2',255)],'Kim132');
 assert.equal(p.failure,'AMBIGUOUS_STYLE');
});
