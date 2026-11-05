'use strict';
const fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const assert=require('node:assert/strict');

test('BLUE invalidation between discarded retry and continuation cannot bind or post',async()=>{
  const file=path.join(__dirname,'pending-job-recovery.spec.cjs');
  let fixture=fs.readFileSync(file,'utf8');
  fixture=fixture.slice(0,fixture.lastIndexOf('(async()=>{let passed=0;'));
  const source="vm.runInContext(fs.readFileSync(path.join(dist,'document-blue.js'),'utf8'),ctx";
  const injected="vm.runInContext(fs.readFileSync(path.join(dist,'document-blue.js'),'utf8').replace('retainPrevious(record);clearSticky();return true;', 'retainPrevious(record);clearSticky();Promise.resolve().then(()=>{document.querySelector(\"#doc-blue-clear\").click();document.__raceObserved=true;});return true;'),ctx";
  assert.ok(fixture.includes(source));
  fixture=fixture.replace(source,injected).replace('return {get,calls,downloads,handoff', 'return {document,get,calls,downloads,handoff');
  const exercise=`return (async()=>{
    const storage=vmStorage();
    const hooks={reply:async(p,body)=>{
      if(p==='/api/blue/jobs')return {id:body.requestId};
      const r=P.read('blue',storage).record;
      return job(r,'failed',{error:'failure'}).body;
    }};
    const page=await bluePage(storage,hooks);
    await page.load();page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
    await until(()=>P.read('blue',storage).record?.disposition==='failed','terminal failure');
    await until(()=>page.get('doc-blue-progress').textContent.includes('실패'),'failure visible');
    page.get('doc-blue-start').click();
    await until(()=>page.document.__raceObserved,'input invalidation');
    await new Promise(r=>setTimeout(r,50));
    assert.equal(page.calls.filter(c=>c.path==='/api/blue/jobs').length,1);
    assert.equal(P.read('blue',storage).status,'absent');
  })();`;
  await new Function('require','__dirname',fixture+exercise)(require,__dirname);
});
