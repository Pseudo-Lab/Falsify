import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
// The source editor uses the Node runtime in the standalone distribution;
// this worktree supplies the browser runtime through the production alias.
const app = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({entryPoints:[fileURLToPath(new URL('../src/paragraph-vendor/editor.mjs',import.meta.url))], bundle:true, platform:'node', format:'esm', write:false,
  plugins:[{name:'browser-runtime',setup(b){
    b.onResolve({filter:/^\.\/runtime\.mjs$/},()=>({path:app+'/src/paragraph-pdf-runtime.mjs'}));
    b.onResolve({filter:/engine-loader\.js$/},()=>({path:app+'/src/paragraph-pdf-engine-loader.mjs'}));
  }}]});
const {planPageEdits} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

const para = (text, x, y, width = 100) => ({id:text, editable:true, box:{x, top:y+8, w:width, h:20}, lines:[{x,y,w:width,off:0},{x,y:y-10,w:width,off:Math.floor(text.length/2)}], runs:[{text, size:10, rgba:0}]});
const edit = (before, after='start changed finish') => ({id:'edit',pageIndex:0,before,after});
const objects = () => [para('start old', 20,100), para('unrelated', 200,90), para(' finish',20,80)];
test('geometric chain preserves intervening paragraphs and original offsets', () => {
  const p=planPageEdits(objects(),[edit('start old finish')]);
  assert.deepEqual(p.failures,[]);
  assert.deepEqual(p.plans[0].touched,[0,2]);
  assert.deepEqual([...p.perPara.keys()],[0]);
  assert.equal([...p.perPara.get(0).del].length,3);
});
test('geometric and ordinary candidates both count for ambiguity', () => {
  const p=planPageEdits([...objects(),para('start old finish',400,100)],[edit('start old finish')]);
  assert.equal(p.failures[0].code,'AMBIGUOUS_MATCH');
});
test('different columns and competing baselines do not form a chain', () => {
  const p=objects(); p[2]=para(' finish',200,80);
  assert.equal(planPageEdits(p,[edit('start old finish')]).failures[0].code,'NOT_FOUND');
  const q=objects(); q.push(para('other',20,80));
  assert.equal(planPageEdits(q,[edit('start old finish')]).failures[0].code,'NOT_FOUND');
});
test('source spans detect overlaps across geometric and ordinary matches', () => {
  const p=planPageEdits(objects(),[edit('start old finish'),{...edit('old','new'),id:'second'}]);
  assert.equal(p.failures[0].code,'OVERLAPPING_EDITS');
});
test('rejects a replacement spanning discontiguous paragraphs', () => {
  const p=planPageEdits(objects(),[edit('start old finish','entirely rewritten')]);
  assert.equal(p.failures[0].code,'UNSUPPORTED_GEOMETRIC_CHANGE');
  assert.equal(p.perPara.size,0);
});
test('shortening retains source prefix and deletes each geometric fragment', () => {
  const p=planPageEdits(objects(),[edit('start old finish','start.')]);
  assert.deepEqual(p.failures,[]);
  assert.deepEqual([...p.perPara.keys()],[0,2]);
  assert.deepEqual(p.perPara.get(0).inserts.map(({ri,o,text})=>({ri,o,text})),[{ri:0,o:5,text:'.'}]);
  assert.deepEqual([...p.perPara.get(0).del],['0:5','0:6','0:7','0:8']);
  assert.equal(p.perPara.get(2).del.size,7);
});
test('does not shorten inside a word', () => {
  const p=planPageEdits(objects(),[edit('start old finish','sta.')]);
  assert.equal(p.failures[0].code,'UNSUPPORTED_GEOMETRIC_CHANGE');
});
test('two geometric chains are ambiguous', () => {
  const p=objects(); p.push(para('start old',400,100),para(' finish',400,80));
  const result=planPageEdits(p,[edit('start old finish')]);
  assert.equal(result.failures[0].code,'AMBIGUOUS_MATCH');
});
