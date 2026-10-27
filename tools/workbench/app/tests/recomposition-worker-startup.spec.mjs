import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installMessageHandler} from '../src/paper-recompose-worker-entry.mjs';

test('first request waits for asynchronous WASM core initialization', async () => {
  let ready, loads=0;
  const messages=[], calls=[], scope={postMessage:value=>messages.push(value)};
  const core=new Promise(resolve=>{ready=resolve;});
  installMessageHandler(scope,()=>{loads++;return core;});
  const first=scope.onmessage({data:{id:1,type:'prepare',request:{revision:7}}});
  assert.equal(loads,1);assert.equal(messages.length,0);
  ready({runRequest:async request=>{calls.push(request);return {revision:request.revision};}});
  await first;
  assert.deepEqual(calls,[{revision:7}]);
  assert.deepEqual(messages,[{id:1,type:'result',result:{revision:7}}]);
});

test('load failure returns the original request identity as an error', async () => {
  const messages=[],scope={postMessage:value=>messages.push(value)};
  installMessageHandler(scope,async()=>{const e=Error('Cannot load bundled core');e.code='asset-load';throw e;});
  await scope.onmessage({data:{id:23,type:'prepare',request:{}}});
  assert.equal(messages[0].id,23);assert.equal(messages[0].type,'error');assert.equal(messages[0].error.code,'asset-load');
  await scope.onmessage({data:{id:'invalid',type:'prepare'}});assert.equal(messages.length,1);
});
