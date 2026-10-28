'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const M=require('../dist/paper-change-marks.js');
const items=[{str:'The effect requires',hasEOL:true},{str:'continued Wnt inhibition.',hasEOL:true}];
test('a clause deletion marks only removed glyphs and a caret in the surviving After',()=>{
  const edit={id:'x',before:'The effect requires\ncontinued Wnt inhibition.',after:'The effect requires inhibition.'};
  const b=M.ranges(items,[edit],'before');assert.equal(b.missing.length,0);assert.deepEqual(b.found.map(x=>[x.itemIndex,x.start,x.end]),[[1,0,14]]);
  const a=M.ranges([{str:edit.after}],[edit],'after');assert.equal(a.found.length,1);assert.equal(a.found[0].caret,true);assert.equal(a.found[0].start,20);
});
test('replacement and insertion preserve unchanged shared prefix/suffix',()=>{
  assert.deepEqual(M.difference('A modest effect.','A major effect.'),{before:{start:3,end:8},after:{start:3,end:7},changed:true});
  const edit={id:'x',before:'효과 있다.',after:'효과가 있다.'};
  assert.equal(M.ranges([{str:edit.before}],[edit],'before').found[0].caret,true);
  assert.equal(M.ranges([{str:edit.after}],[edit],'after').found[0].caret,false);
});
test('hyphenation and whitespace resolve to real original item offsets',()=>{
  const edit={id:'x',before:'differen-\ntiation capacity',after:'differentiation competency'};
  assert.equal(M.ranges([{str:'differentiation capacity'}],[edit],'before').missing.length,0);
  assert.equal(M.ranges([{str:'differentiation competency'}],[edit],'after').found[0].start,'differentiation competency'.indexOf('competency')+1);
});
test('ambiguous and absent output quotes never guess a position',()=>{
  const edit={id:'x',before:'small effect',after:'large effect'};
  assert.deepEqual(M.ranges([{str:'large effect large effect'}],[edit],'after').found,[]);
  assert.deepEqual(M.ranges([{str:'other words'}],[edit],'after').missing,['x']);
});
test('disabled edits and unchanged content make no marks; offsets remain UTF16-safe',()=>{
  assert.equal(M.ranges(items,[{id:'x',enabled:false,before:'The',after:'An'}],'before').found.length,0);
  assert.equal(M.difference('same','same').changed,false);
  const r=M.difference('A😀Z','A😁Z');assert.equal(r.before.start,1);assert.equal(r.before.end,3);
});
test('mark planning does not mutate edits or PDF text items',()=>{
  const edit={id:'x',before:'The effect requires\ncontinued Wnt inhibition.',after:'The effect requires inhibition.'};
  const before=JSON.stringify({items,edit});M.ranges(items,[edit],'before');M.ranges(items,[edit],'after');assert.equal(JSON.stringify({items,edit}),before);
});
