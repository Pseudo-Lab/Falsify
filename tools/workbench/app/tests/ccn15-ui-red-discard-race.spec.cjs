'use strict';
const fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const assert=require('node:assert/strict');

test('RED invalidation after prior retry discard cannot start a stale request',async()=>{
  let fixture=fs.readFileSync(path.join(__dirname,'pending-job-recovery.spec.cjs'),'utf8');
  fixture=fixture.slice(0,fixture.lastIndexOf('(async()=>{let passed=0;'));
  const source="vm.runInContext(fs.readFileSync(path.join(dist,'document-red.js'),'utf8'),ctx";
  const injected="vm.runInContext(fs.readFileSync(path.join(dist,'document-red.js'),'utf8').replace('if(details)details.hidden=true;return true;', 'if(details)details.hidden=true;Promise.resolve().then(()=>{document.dispatchEvent(new Event(\\\"falsify:document-clear\\\"));document.__raceObserved=true;});return true;'),ctx";
  assert.ok(fixture.includes(source));
  fixture=fixture.replace(source,injected).replace('return {get,find:id=>els.get(id),calls,downloads', 'return {document,get,find:id=>els.get(id),calls,downloads');
  const exercise=`return (async()=>{
    const storage=vmStorage();
    const page=await redPage(storage,{reply:async(p,body)=>{
      if(p==='/api/red/jobs')return {id:body.requestId};
      const r=P.read('red',storage).record;return job(r,'failed',{error:'failure'}).body;
    }});
    await page.load();page.get('red-consent').checked=true;page.get('red-start').click();
    await until(()=>P.read('red',storage).record?.disposition==='failed','terminal failure');
    await until(()=>page.get('red-progress').textContent.includes('실패'),'failure visible');
    page.get('red-start').click();await until(()=>page.document.__raceObserved,'input invalidation');
    await new Promise(r=>setTimeout(r,50));
    assert.equal(page.calls.filter(c=>c.path==='/api/red/jobs').length,1);
    assert.equal(P.read('red',storage).status,'absent');
  })();`;
  await new Function('require','__dirname',fixture+exercise)(require,__dirname);
});
