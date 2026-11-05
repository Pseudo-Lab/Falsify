import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('source loader isolates cancellation and rejects stale worker messages',async()=>{
  const workers=[];
  class Worker {constructor(){workers.push(this);} postMessage(message){this.message=message;} terminate(){this.terminated=true;}}
  const context={document:{currentScript:{src:'https://example.test/paragraph-pdf.js'}},Worker,URL,File,Map,Uint8Array,ArrayBuffer,Promise,Error};
  vm.runInNewContext(readFileSync(new URL('../src/paragraph-pdf-loader.js',import.meta.url),'utf8'),context);
  const controller=new AbortController(),bytes=new Uint8Array([37,80,68,70,45]);
  const first=context.FalsifyParagraphPdf.inspectPage({file:bytes,signal:controller.signal});
  const second=context.FalsifyParagraphPdf.inspectPage({file:bytes});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(workers.length,2);
  workers[1].onmessage({data:{id:workers[0].message.id,ok:true,result:{stale:true}}});
  controller.abort();await assert.rejects(first,{code:'aborted'});assert.equal(workers[0].terminated,true);
  workers[1].onmessage({data:{id:workers[1].message.id,ok:true,result:{value:42}}});
  assert.equal((await second).value,42);assert.equal(workers[1].terminated,true);
});
