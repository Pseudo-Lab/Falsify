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
test('opt-in PDF geometry joining retains the existing default separator',()=>{
  const edit={id:'x',before:'Claim62 continues',after:'Claim63 continues'};
  const runs=[{str:'Claim'},{str:'62'},{str:' continues'}];
  assert.deepEqual(M.ranges(runs,[edit],'before').missing,['x']);
  const joined=M.ranges(runs,[edit],'before',()=> '');
  assert.deepEqual(joined.found.map(h=>[h.itemIndex,h.start,h.end]),[[1,1,2]]);
});
test('DOM range painter uses the measured glyph rectangle and does not mark an ambiguous quote',()=>{
  const nodes=[];const doc={createElement(){return {dataset:{},style:{},children:[],setAttribute(){},append(x){this.children.push(x);},className:''};},createRange(){return {setStart(n,i){this.start=i;},setEnd(n,i){this.end=i;},getClientRects(){return [{left:120,top:55,right:130,width:10,height:8}];}};}};
  const container={append(x){nodes.push(x);},getBoundingClientRect(){return {left:100,top:50};}};
  const divs=[{dataset:{},firstChild:{nodeType:3,textContent:'Claim62 continues'}}];
  const result=M.paintPage({document:doc,container,items:[{str:'Claim62 continues'}],divs,edits:[{id:'a',before:'Claim62 continues',after:'Claim63 continues'}],side:'before'});
  assert.equal(result.count,1);assert.equal(result.layer.children[0].style.left,'20px');assert.equal(result.layer.children[0].style.width,'10px');
  const ambiguous=M.paintPage({document:doc,container,items:[{str:'Claim62 continues Claim62 continues'}],divs,edits:[{id:'a',before:'Claim62 continues',after:'Claim63 continues'}],side:'before'});
  assert.equal(ambiguous.count,0);assert.deepEqual(ambiguous.missing,['a']);
});
