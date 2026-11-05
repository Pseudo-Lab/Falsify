import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {javascriptFunctions,pythonFunctions,violations} from './complexity.mjs';

test('regex punctuation is not control flow; nested functions have separate counts',()=>{
  const list=javascriptFunctions(String.raw`function outer(x) { const r=/if|while\?\//; function inner(y) { if(y && x) return 1; } if(x) return r; }`);
  assert.deepEqual(list.map(x=>[x.id,x.ccn]),[['/outer#1',2],['/outer#1/inner#1',3]]);
});
test('Python nested decisions belong to the inner function',()=>{
  const list=pythonFunctions('def outer(x):\n    def inner(y):\n        if y and x:\n            return 1\n    if x:\n        return inner(x)\n');
  assert.deepEqual(list.map(x=>[x.id,x.ccn]),[['/outer#1',2],['/outer#1/inner#1',3]]);
});
test('Python AST protocol uses UTF-8 despite cp949 standard streams',()=>{
  const source='def 한글():\n    return "한글 🧪"\n';
  const script=fileURLToPath(new URL('./python-functions.py',import.meta.url));
  const run=spawnSync(process.env.PYTHON || 'python',[script],{
    input:Buffer.from(source,'utf8'),
    env:{...process.env,PYTHONUTF8:'0',PYTHONIOENCODING:'cp949'},
  });
  assert.equal(run.status,0,run.stderr.toString('utf8'));
  assert.deepEqual(JSON.parse(run.stdout.toString('utf8')),[{id:'/한글#1',ccn:1,source:source.trimEnd()}]);
});
test('threshold rejects increases and permits unchanged and retained baselines',()=>{
  const old=[{id:'/a#1',ccn:55,source:'old'}];
  assert.equal(violations(old,[{id:'/a#1',ccn:56,source:'new'}]).length,1);
  assert.equal(violations(old,[{id:'/a#1',ccn:55,source:'new'}]).length,0);
  assert.equal(violations(old,[{id:'/a#1',ccn:55,source:'old'}],1).length,0);
  assert.equal(violations([], [{id:'/a#1',ccn:51,source:'new'}]).length,1);
  assert.equal(violations([], [{id:'/a#1',ccn:51,source:'new'}],50,{'/a#1':{reason:'tracked rationale',ceiling:51}}).length,0);
  assert.throws(()=>violations([],[],-1));
});
