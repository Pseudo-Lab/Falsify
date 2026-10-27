import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesStationaryReorderedGlyphs} from '../src/paragraph-vendor/quality.mjs';

const style = {font:'Synthetic', flags:0, size:10, render:0, fill:null, stroke:null, mat:null};
function page(chars) {
  const items = chars.map((x, i) => typeof x === 'string' ? {ch:x, x:i} : x);
  return {styled:true, text:items.map(x=>x.ch).join(''), chars:items.map(x=>({u:x.ch.charCodeAt(0), generated:!!x.generated})),
    glyphs:items.flatMap((x,i)=>/\s/.test(x.ch) ? [] : [{u:x.ch.charCodeAt(0),i,l:x.x,r:x.x+.8,b:10,t:11,style:x.style ?? style}])};
}
const source = page([{ch:'A',x:1},{ch:'1',x:2},{ch:'.',x:3},{ch:' ',x:4},{ch:'B',x:5}]);
const edits = [{id:'edit',before:'B',after:'C'}];
const output = (citation = {ch:'1',x:2}) => page([{ch:'A',x:1},{ch:' ',x:2.5,generated:true},{ch:'.',x:3},{ch:' ',x:4},{ch:'C',x:5}, {ch:' ',generated:true}, citation]);
test('stationary citation can return to source reading order after an edit',()=>{
  assert.equal(matchesStationaryReorderedGlyphs(source,output(),edits),true);
});
test('conservation rejects missing, extra, moved or restyled citation and altered unrelated text',()=>{
  assert.equal(matchesStationaryReorderedGlyphs(source,output({ch:'2',x:2}),edits),false);
  assert.equal(matchesStationaryReorderedGlyphs(source,output({ch:'1',x:20}),edits),false);
  assert.equal(matchesStationaryReorderedGlyphs(source,output({ch:'1',x:2,style:{...style,font:'Other'}}),edits),false);
  const extra=output(); extra.chars.push({u:88}); extra.text+='X'; assert.equal(matchesStationaryReorderedGlyphs(source,extra,edits),false);
  const altered=output(); altered.chars[0].u=90; altered.text='Z'+altered.text.slice(1); assert.equal(matchesStationaryReorderedGlyphs(source,altered,edits),false);
});
test('non-generated whitespace away from the relocated glyph remains mandatory',()=>{
  const src=page([{ch:'A',x:1},{ch:'1',x:2},{ch:'.',x:3},{ch:' ',x:4},{ch:'B',x:5},{ch:'B',x:6}]);
  const out=page([{ch:'A',x:1},{ch:'.',x:3},{ch:' ',x:4},{ch:'C',x:5},{ch:' ',x:5.5},{ch:'C',x:6},{ch:' ',generated:true},{ch:'1',x:2}]);
  assert.equal(matchesStationaryReorderedGlyphs(src,out,[{id:'e',before:'BB',after:'CC'}]),false);
});
test('unchanged text cannot move through the reordered citation or be duplicated',()=>{
  const bad=page([{ch:'A',x:1},{ch:' ',x:2.5},{ch:'C',x:5},{ch:' ',x:4},{ch:'.',x:3},{ch:' ',generated:true},{ch:'1',x:2}]);
  assert.equal(matchesStationaryReorderedGlyphs(source,bad,edits),false);
  const duplicate=output(); duplicate.chars.push({u:49}); duplicate.text+='1'; assert.equal(matchesStationaryReorderedGlyphs(source,duplicate,edits),false);
  const ambiguous=page([{ch:'A',x:1},{ch:'1',x:2},{ch:'1',x:2},{ch:'.',x:3},{ch:' ',x:4},{ch:'B',x:5}]);
  assert.equal(matchesStationaryReorderedGlyphs(ambiguous,output(),edits),false);
});

test('a literal word gap after a stationary citation relocation is rejected',()=>{
  const out=output();
  out.chars[1].generated=false;
  assert.equal(matchesStationaryReorderedGlyphs(source,out,edits),false);
});
import {removeForeignObjectGapSpaces} from '../src/paragraph-vendor/engine/foreign-gap.mjs';
const owned = new Set([1, 2]);
const foreignChars = () => [
  {index:0,ch:'A',obj:1,box:[0,1,0,2]},
  {index:1,ch:'1',obj:3,box:[1.1,1.9,1,2.5]},
  {index:2,ch:'.',obj:2,box:[2,3,0,1]},
  {index:3,ch:'B',obj:2,box:[3,4,0,2]},
];
test('writer removes only a model space across an intervening foreign glyph',()=>{
  const model=[{text:'A .B'}], runs=[{text:'A .C',sourceIndex:0}];
  assert.equal(removeForeignObjectGapSpaces(model,runs,foreignChars(),owned)[0].text,'A.C');
  assert.equal(runs[0].text,'A .C');
});
test('writer preserves spaces without exact source ownership and geometry proof',()=>{
  const model=[{text:'A .B'}], runs=[{text:'A .C'}];
  const check=chars=>assert.equal(removeForeignObjectGapSpaces(model,runs,chars,owned)[0].text,'A .C');
  let chars=foreignChars(); chars[1].box=[8,9,1,2.5]; check(chars);
  chars=foreignChars(); chars[1].obj=1; check(chars);
  chars=foreignChars(); chars[1].ch=' '; check(chars);
  chars=foreignChars(); chars[0].ch='Z'; check(chars);
  assert.equal(removeForeignObjectGapSpaces(model,[{text:'Z .C'}],foreignChars(),owned)[0].text,'Z .C');
  assert.equal(removeForeignObjectGapSpaces(model,[{text:'A X.C'}],foreignChars(),owned)[0].text,'A X.C');
});
