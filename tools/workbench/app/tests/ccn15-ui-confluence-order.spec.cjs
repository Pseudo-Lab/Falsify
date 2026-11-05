'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const fixturePath=path.join(__dirname,'confluence-store.spec.cjs');
const source=fs.readFileSync(fixturePath,'utf8').split("test('index loads Confluence controls")[0];
const fixture=new Module(fixturePath,module);
fixture.filename=fixturePath;fixture.paths=module.paths;
fixture._compile(source+'\nmodule.exports={setup,teamApi,codecStub,connect,arm,until,liveIntervals};',fixturePath);
const {setup,teamApi,codecStub,connect,arm,until,liveIntervals}=fixture.exports;
test('failed archive serialization stops before body encoding or publication',async()=>{
  globalThis.crypto ||= require('node:crypto').webcrypto;
  const api=teamApi(), codec=codecStub(); let serializations=0;
  codec.validateArchive=async()=>({toJSON(){serializations++;return undefined;}});
  const t=setup({routes:api.routes,codec});
  try{
    await t.ready;await connect(t);arm(t);t.$('confluence-review-share').click();
    await until(()=>/응답을 해석하지 못했습니다/.test(t.$('confluence-review-status').textContent),'serialization failure');
    assert.equal(serializations,1);
    assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path==='/v1/confluence/archives').length,0);
  }finally{for(const id of liveIntervals)clearInterval(id);liveIntervals.clear();}
});
