import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreSourceWordGaps} from '../src/paragraph-vendor/engine/foreign-gap.mjs';

const owned = new Set([1, 2]);
const chars = () => [
  {index:0,ch:'b',obj:1,box:[0,1,0,2]},
  {index:1,ch:' ',obj:2,box:[1.1,1.9,.2,.3]},
  {index:2,ch:'a',obj:2,box:[2,3,0,2]},
  {index:3,ch:'n',obj:2,box:[3,4,0,2]},
  {index:4,ch:'d',obj:2,box:[4,5,0,2]},
];
const model = [{text:'b'}, {text:' and'}];
const runs = () => [{text:'b',sourceIndex:0,font:'bold'}, {text:' and',sourceIndex:1,font:'regular'}];

test('preserves a source-proven space at a styled run boundary', () => {
  const input = runs();
  const out = restoreSourceWordGaps(model,input,chars(),owned);
  assert.deepEqual(out.map(r => r.text), ['b ','and']);
  assert.deepEqual(out.map(r => r.font), ['bold','regular']);
  assert.deepEqual(input.map(r => r.text), ['b',' and']);
});

test('restores a source-proven missing model gap only in unchanged text', () => {
  const src = [{text:'band!'}], output = [{text:'band?',sourceIndex:0}];
  const cs = [...chars(), {index:5,ch:'!',obj:2,box:[5,6,0,2]}];
  assert.equal(restoreSourceWordGaps(src,output,cs,owned)[0].text,'b and?');
  const suffixSource = [{text:'!band'}];
  const suffixChars = [{index:0,ch:'!',obj:1,box:[-1,0,0,2]}, ...chars().map(c=>({...c,index:c.index+1}))];
  assert.equal(restoreSourceWordGaps(suffixSource,[{text:'?band',sourceIndex:0}],suffixChars,owned)[0].text,'?b and');
  assert.equal(restoreSourceWordGaps(src,[{text:'bXand!',sourceIndex:0}],cs,owned)[0].text,'bXand!');
  assert.equal(restoreSourceWordGaps(src,[{text:'b and!',sourceIndex:0}],cs,owned)[0].text,'b and!');
});

test('foreign glyphs and unsupported whitespace cannot establish a word gap', () => {
  const cs = chars(); cs[1] = {...cs[1],ch:'1',obj:3};
  assert.deepEqual(restoreSourceWordGaps(model,runs(),cs,owned).map(r=>r.text), ['b',' and']);
  const unknown = chars(); unknown[1] = {...unknown[1],obj:3};
  assert.deepEqual(restoreSourceWordGaps(model,runs(),unknown,owned).map(r=>r.text), ['b',' and']);
});

test('edits over a boundary or a changed adjacent run are respected', () => {
  for (const input of [
    [{text:'b',sourceIndex:0},{text:'and',sourceIndex:1}],
    [{text:'B',sourceIndex:0},{text:' and',sourceIndex:1}],
    [{text:'b',sourceIndex:0},{text:' Xand',sourceIndex:1}],
  ]) assert.deepEqual(restoreSourceWordGaps(model,input,chars(),owned),input);
});
