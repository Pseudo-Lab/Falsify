import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, zipSync} from 'fflate';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {encodeLayoutRun,decodeLayoutRun,exportLayoutRun,importLayoutRun,createLayoutRunStore,LAYOUT_RUN_TTL_MS,LAYOUT_RUN_DB_NAME,MAX_LAYOUT_CHECKPOINTS} from '../src/paper-layout-run-store.mjs';
import {encodeSourceSession,decodeSourceSession} from '../src/latex-session-archive.mjs';
import {serialIndexedDB,until} from './serial-indexeddb.mjs';

const enc=new TextEncoder();
const asset=Uint8Array.of(137,80,78,71,0,1,2,3,255);
const pdf=text=>enc.encode(`%PDF-1.4\n% synthetic ${text}\n%%EOF\n`);
const tex=body=>enc.encode(`\\documentclass{article}\\begin{document}${body}\\end{document}`);
async function project(body,{image=asset,engine='pdflatex'}={}){return createLatexProject({files:[{path:'main.tex',bytes:tex(body)},{path:'fig.png',bytes:image}],mainFile:'main.tex',engine,origin:'reconstructed-pdf',sourcePdfHash:'c'.repeat(64)});}
function artifact(p,text){const pdfBytes=pdf(text);return {schema:'falsify.latex-artifact.v1',success:true,projectId:p.id,engine:p.engine,engineManifest:{engine:p.engine},key:'k-'+text,diagnostics:[],pdfBytes,pdfHash:hex(pdfBytes),synctex:enc.encode('synctex '+text)};}
async function fixture({runId='run-1',runState='completed'}={}){
  const baselineProject=await project('Baseline with selected RED edit.'),baselineArtifact=artifact(baselineProject,'baseline');
  const prevProject=await project('First layout candidate.'),prevArtifact=artifact(prevProject,'prev');
  const currentProject=await project('Current layout candidate.'),candidateArtifact=artifact(currentProject,'current');
  const sourceOnly=await project('Checkpoint without PDF.');
  return {schema:'falsify.layout-run-state.v1',runId,parentRunId:'run-0',carriedStepCount:3,baselineProject,baselineArtifact,currentProject,
    candidate:{project:currentProject,artifact:candidateArtifact},previousCandidate:{project:prevProject,artifact:prevArtifact},
    checkpoints:[{revisionId:'r1',label:'first',project:prevProject,artifact:prevArtifact},{revisionId:'r2',label:'source only',project:sourceOnly,artifact:null}],
    trace:[{action:'compile',result:{status:'ok'},projectId:currentProject.id,pdfHash:candidateArtifact.pdfHash},{action:'note',result:{text:'$(rm -rf /); `curl x`',token:'secret-connection-token',comparison:{tokens:{text:{missing:[]}}}}}],
    coverage:{status:'partial',visualQualityVerified:false},quality:{content:'unchanged',layout:'issues',observedPages:[0],findings:[{code:'overlap',severity:'warning',document:'candidate',pageIndex:0,message:'Caption overlaps figure'}]},
    status:'needs_review',runState,stepCount:5};
}
function fakeIndexedDB({quota=Infinity}={}){
  const dbs=new Map([['falsify-user-records',new Map([['records',{keyPath:'id',rows:new Map([['keep',{id:'keep',value:1}]])}]])]]),opened=[];
  const later=f=>setTimeout(f,0);
  const db=name=>{const stores=dbs.get(name);return {objectStoreNames:{contains:n=>stores.has(n)},createObjectStore:(n,{keyPath})=>stores.set(n,{keyPath,rows:new Map()}),close(){},
    transaction(n,mode){const st=stores.get(n),staged=new Map(st.rows);let pending=0,failed=null,finished=false;const t={error:null,abort(){failed??=new DOMException('aborted','AbortError');}};
      const settle=()=>later(()=>{if(pending||finished)return;finished=true;if(failed){t.error=failed;t.onerror?.();t.onabort?.();}else{st.rows=staged;t.oncomplete?.();}});
      const request=fn=>{pending++;const r={};later(()=>{try{r.result=fn();r.onsuccess?.();}catch(e){r.error=e;failed=e;r.onerror?.();}pending--;settle();});return r;};
      t.objectStore=()=>({put:v=>request(()=>{if(mode!=='readwrite')throw new DOMException('ro','ReadOnlyError');if(JSON.stringify(v).length>quota)throw new DOMException('quota','QuotaExceededError');staged.set(v[st.keyPath],structuredClone(v));}),
        get:k=>request(()=>structuredClone(staged.get(k))),getAll:()=>request(()=>[...staged.values()].map(v=>structuredClone(v))),delete:k=>request(()=>{staged.delete(k);}),clear:()=>request(()=>{staged.clear();})});
      settle();return t;}};};
  return {opened,dbs,rows:()=>[...(dbs.get(LAYOUT_RUN_DB_NAME)?.get('runs')?.rows.values()||[])],
    open(name){opened.push(name);const r={};later(()=>{const fresh=!dbs.has(name);if(fresh)dbs.set(name,new Map());r.result=db(name);if(fresh)r.onupgradeneeded?.();r.onsuccess?.();});return r;}};
}
const sameBytes=(a,b)=>assert.deepEqual([...a],[...b]);

test('string codec roundtrips baseline, candidate, previous candidate and source-only checkpoint',async()=>{
  const f=await fixture(),json=await encodeLayoutRun(f),out=await decodeLayoutRun(json);
  assert.equal(out.runId,'run-1');assert.equal(out.parentRunId,'run-0');assert.equal(out.carriedStepCount,3);assert.equal(out.runState,'completed');assert.equal(out.stepCount,5);
  assert.equal(out.baselineProject.id,f.baselineProject.id);sameBytes(out.baselineArtifact.pdfBytes,f.baselineArtifact.pdfBytes);
  assert.equal(out.candidate.project.id,f.currentProject.id);assert.equal(out.candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);sameBytes(out.candidate.artifact.synctex,f.candidate.artifact.synctex);
  assert.equal(out.previousCandidate.artifact.pdfHash,f.previousCandidate.artifact.pdfHash);assert.equal(out.previousCandidate.project.id,f.previousCandidate.project.id);
  assert.deepEqual(out.checkpoints.map(c=>[c.revisionId,c.label,c.project.id,c.artifact?.pdfHash??null]),[['r1','first',f.checkpoints[0].project.id,f.checkpoints[0].artifact.pdfHash],['r2','source only',f.checkpoints[1].project.id,null]]);
  assert.deepEqual(out.quality,f.quality);assert.deepEqual(out.coverage,f.coverage);
  // Trace strings remain inert data; credential-named keys are dropped, ordinary `tokens` data kept.
  assert.equal(out.trace[1].result.text,'$(rm -rf /); `curl x`');assert.equal('token' in out.trace[1].result,false);assert.ok(out.trace[1].result.comparison.tokens);
  assert.equal(json.includes('secret-connection-token'),false);
  // fig.png is shared by every project and stored once.
  const assets=JSON.parse(json).payload.assets;assert.equal(Object.keys(assets).filter(h=>h===hex(asset)).length,1);
  assert.equal(Object.keys(assets).length,new Set(Object.keys(assets)).size);
});

test('ZIP export stores each asset once and imports to the same validated state',async()=>{
  const f=await fixture(),zip=await exportLayoutRun(f),entries=unzipSync(zip),names=Object.keys(entries);
  assert.ok(names.includes('layout-run.json'));assert.ok(names.includes('assets/'+hex(asset)));
  for(const n of names.filter(n=>n.startsWith('assets/')))assert.equal(hex(entries[n]),n.slice(7));
  const out=await importLayoutRun(zip);assert.equal(out.candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);assert.equal(out.checkpoints[1].artifact,null);
  assert.deepEqual(await decodeLayoutRun(await encodeLayoutRun(out)).then(s=>s.trace),out.trace);
});

test('tampered, mismatched or oversized runs are rejected before use',async()=>{
  const f=await fixture(),json=await encodeLayoutRun(f);
  const a=JSON.parse(json);const h=a.payload.state.candidate.artifact.pdfHash;a.payload.assets[h]=btoa('%PDF-1.4 forged');
  await assert.rejects(decodeLayoutRun(JSON.stringify(a)));
  const b=JSON.parse(json);b.payload.state.runState='done';await assert.rejects(decodeLayoutRun(JSON.stringify(b)));
  // Re-sealed with a valid checksum, the forged asset still fails its own hash.
  const c=JSON.parse(json);c.payload.assets[h]=btoa('forged');const body=JSON.stringify(c.payload);c.sha256=hex(enc.encode(body));await assert.rejects(decodeLayoutRun(JSON.stringify(c)));
  // PDF paired with a different project.
  await assert.rejects(encodeLayoutRun({...f,candidate:{project:f.currentProject,artifact:f.previousCandidate.artifact}}));
  // Source asset changed relative to the baseline.
  const other=await project('Current layout candidate.',{image:Uint8Array.of(9,9)});await assert.rejects(encodeLayoutRun({...f,currentProject:other,candidate:{project:other,artifact:artifact(other,'x')}}));
  // Different source PDF lineage.
  const foreign=await createLatexProject({files:[{path:'main.tex',bytes:tex('x')},{path:'fig.png',bytes:asset}],mainFile:'main.tex',origin:'reconstructed-pdf',sourcePdfHash:'d'.repeat(64)});
  await assert.rejects(encodeLayoutRun({...f,currentProject:foreign,candidate:{project:foreign,artifact:null}}));
  // Forged project hash.
  const forged={...f.currentProject,files:f.currentProject.files.map(x=>x.path==='main.tex'?{...x,bytes:tex('tampered')}:x)};await assert.rejects(encodeLayoutRun({...f,currentProject:forged}));
  await assert.rejects(encodeLayoutRun({...f,checkpoints:Array.from({length:MAX_LAYOUT_CHECKPOINTS+1},(_,i)=>({revisionId:'r'+i,label:'x',project:f.currentProject,artifact:null}))}));
  await assert.rejects(encodeLayoutRun({...f,runId:'../../etc'}));
  await assert.rejects(encodeLayoutRun({...f,trace:[{action:'x',bytes:new Uint8Array(1)}]}));
  await assert.rejects(encodeLayoutRun({...f,checkpoints:[f.checkpoints[0],f.checkpoints[0]]}));
  // ZIP: extra entry, replaced asset and missing manifest.
  const entries=unzipSync(await exportLayoutRun(f));
  await assert.rejects(importLayoutRun(zipSync({...entries,'run.sh':enc.encode('echo')})));
  await assert.rejects(importLayoutRun(zipSync({...entries,['assets/'+h]:enc.encode('forged')})));
  const {['layout-run.json']:_,...noManifest}=entries;await assert.rejects(importLayoutRun(zipSync(noManifest)));
  await assert.rejects(importLayoutRun(enc.encode('not a zip')));
});

test('store retains memory without IndexedDB and surfaces the storage error',async()=>{
  const f=await fixture(),store=createLayoutRunStore({indexedDB:undefined});
  assert.deepEqual(await store.put(f),{runId:'run-1',savedAt:(await store.list())[0].savedAt,persisted:false});
  const r=await store.put(f,{consent:true});assert.equal(r.persisted,false);assert.equal(r.storageError.code,'STORAGE_UNAVAILABLE');
  const got=await store.get('run-1');assert.equal(got.candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);assert.equal((await store.get()).runId,'run-1');
  assert.equal(got.candidate.artifact.pdfBytes,f.candidate.artifact.pdfBytes,'unchanged buffers are reused, not cloned');
  assert.equal((await store.list()).length,1);
});

test('quota failure keeps the current candidate in memory',async()=>{
  const idb=fakeIndexedDB({quota:100}),f=await fixture(),store=createLayoutRunStore({indexedDB:idb});
  const r=await store.put(f,{consent:true});assert.equal(r.persisted,false);assert.equal(r.storageError.code,'STORAGE_QUOTA');assert.equal(store.lastError.code,'STORAGE_QUOTA');
  assert.equal(idb.rows().length,0);assert.equal((await store.get('run-1')).candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);
});

test('persistence needs explicit consent, survives reload and expires after twelve hours',async()=>{
  let clock=1_000_000;const idb=fakeIndexedDB(),f=await fixture(),now=()=>clock;
  const s1=createLayoutRunStore({indexedDB:idb,now});
  assert.equal((await s1.put(f)).persisted,false);assert.equal(idb.rows().length,0);
  assert.equal((await s1.put(f,{consent:true})).persisted,true);assert.equal(idb.rows().length,1);assert.equal(idb.rows()[0].expiresAt,clock+LAYOUT_RUN_TTL_MS);
  assert.equal(idb.rows()[0].data.includes('secret-connection-token'),false);
  s1.dispose();await assert.rejects(s1.get('run-1'),/disposed/);
  const s2=createLayoutRunStore({indexedDB:idb,now});
  const restored=await s2.get('run-1');assert.equal(restored.candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);assert.equal(restored.previousCandidate.artifact.pdfHash,f.previousCandidate.artifact.pdfHash);
  assert.deepEqual((await s2.list()).map(x=>[x.runId,x.persisted]),[['run-1',true]]);
  clock+=LAYOUT_RUN_TTL_MS-1;assert.ok(await s2.get('run-1'));
  clock+=1;assert.equal(await s2.get('run-1'),null);assert.deepEqual(await s2.list(),[]);assert.equal(idb.rows().length,0,'expired record is removed');
  // Tampered persisted record is discarded, not returned.
  const s3=createLayoutRunStore({indexedDB:idb,now});await s3.put(f,{consent:true});
  const row=idb.dbs.get(LAYOUT_RUN_DB_NAME).get('runs').rows.get('run-1');row.data=row.data.replace('needs_review','completed');
  assert.equal(await createLayoutRunStore({indexedDB:idb,now}).get('run-1'),null);assert.equal(idb.rows().length,0);
  assert.deepEqual(idb.opened.filter(n=>n!==LAYOUT_RUN_DB_NAME),[]);
});

test('consent withdrawal deletes persisted runs only, keeping memory and unrelated records',async()=>{
  const idb=fakeIndexedDB(),f=await fixture(),store=createLayoutRunStore({indexedDB:idb});
  await store.setConsent(true);assert.equal((await store.put(f)).persisted,true);
  await store.setConsent(false);assert.equal(idb.rows().length,0);assert.equal(store.consent,false);
  assert.equal((await store.put(f)).persisted,false);assert.equal(idb.rows().length,0);
  assert.equal((await store.get('run-1')).runId,'run-1');assert.equal(await createLayoutRunStore({indexedDB:idb}).get('run-1'),null);
  assert.equal(idb.dbs.get('falsify-user-records').get('records').rows.get('keep').value,1);
  // A consented write in flight when consent is withdrawn is undone.
  const pending=store.put(f,{consent:true});await store.setConsent(false);assert.equal((await pending).persisted,false);assert.equal(idb.rows().length,0);
  await store.clear();assert.equal(idb.dbs.get('falsify-user-records').get('records').rows.size,1);
});

test('starting another run keeps the previous run and its completed candidate',async()=>{
  const idb=fakeIndexedDB(),store=createLayoutRunStore({indexedDB:idb});
  const first=await fixture({runId:'run-1',runState:'completed'});await store.put(first,{consent:true});
  const second=await fixture({runId:'run-2',runState:'running'});
  const fresh={...second,currentProject:first.baselineProject,candidate:{project:first.baselineProject,artifact:first.baselineArtifact}};delete fresh.previousCandidate;
  await store.put(fresh,{consent:true});
  assert.equal((await store.get()).runId,'run-2');
  const kept=await store.get('run-1');assert.equal(kept.runState,'completed');assert.equal(kept.candidate.artifact.pdfHash,first.candidate.artifact.pdfHash);
  assert.deepEqual((await store.list()).map(x=>x.runId).sort(),['run-1','run-2']);
  assert.equal((await store.list()).find(x=>x.runId==='run-1').candidatePdfHash,first.candidate.artifact.pdfHash);
  assert.equal(idb.rows().length,2);
  // Updating the same run replaces only that snapshot.
  await store.put({...fresh,runState:'completed',stepCount:2});assert.equal((await store.get('run-2')).stepCount,2);assert.equal((await store.get('run-1')).stepCount,5);
});

test('source session archive keeps legacy format and roundtrips an optional layoutRun',async()=>{
  const p=await project('Hello world'),f=await fixture();
  const session={project:p,changes:[],responses:null,selection:null,unfinishedEdit:null,baseline:null};
  const legacy=await encodeSourceSession(session,{createLatexProject});
  assert.equal('layoutRun' in JSON.parse(legacy).payload,false);
  const oldOut=await decodeSourceSession(legacy,{createLatexProject});assert.equal(oldOut.layoutRun,null);assert.equal(oldOut.project.id,p.id);
  const json=await encodeSourceSession({...session,layoutRun:f},{createLatexProject});
  const out=await decodeSourceSession(json,{createLatexProject});
  assert.equal(out.layoutRun.runId,'run-1');assert.equal(out.layoutRun.candidate.artifact.pdfHash,f.candidate.artifact.pdfHash);assert.equal(out.layoutRun.checkpoints[1].artifact,null);
  // layoutRun is covered by the outer checksum.
  const t=JSON.parse(json);t.payload.layoutRun.payload.state.status='completed';await assert.rejects(decodeSourceSession(JSON.stringify(t),{createLatexProject}));
  const foreign=await createLatexProject({files:[{path:'main.tex',bytes:tex('x')}],mainFile:'main.tex',origin:'reconstructed-pdf',sourcePdfHash:'e'.repeat(64)});
  await assert.rejects(encodeSourceSession({...session,project:foreign,layoutRun:f},{createLatexProject}));
});

// F6: transactions are serialized in creation order like real IndexedDB. These cases
// order a stale write's rollback/cleanup after a newer row of the same runId.
const runRows=idb=>idb.rows(LAYOUT_RUN_DB_NAME,'runs').map(([,v])=>v);
test('late consent-withdrawal rollback never deletes the newer re-consented row of the same runId',async()=>{
  const idb=serialIndexedDB(),f=await fixture(),store=createLayoutRunStore({indexedDB:idb});
  await store.setConsent(true);assert.equal((await store.put(f)).persisted,true);
  idb.pause();const base=idb.created;
  const a=store.put(f);await until(()=>idb.created>=base+1);            // write A queued
  const withdrawn=store.setConsent(false);await until(()=>idb.created>=base+2); // clear queued after A
  await store.setConsent(true);
  const b=store.put({...f,stepCount:6});await until(()=>idb.created>=base+3);   // re-consented write B
  idb.resume();
  assert.equal((await a).persisted,false,'A was withdrawn while in flight');await withdrawn;
  assert.equal((await b).persisted,true);
  // A's rollback ran after B committed; B must survive and be the only row.
  const rows=runRows(idb);assert.equal(rows.length,1);assert.equal((await decodeLayoutRun(rows[0].data)).stepCount,6);
  assert.equal((await createLayoutRunStore({indexedDB:idb}).get('run-1')).stepCount,6,'newer row survives reload');
});

test('a write whose epoch changed before it was issued is never queued over a newer row',async()=>{
  const idb=serialIndexedDB(),f=await fixture(),store=createLayoutRunStore({indexedDB:idb});
  await store.setConsent(true);
  const a=store.put(f);                                  // still validating/encoding
  const withdrawn=store.setConsent(false);await store.setConsent(true);
  const b=store.put({...f,stepCount:7});
  const [ra,,rb]=await Promise.all([a,withdrawn,b]);
  assert.equal(ra.persisted,false);assert.equal(rb.persisted,true);
  const rows=runRows(idb);assert.equal(rows.length,1);assert.equal((await decodeLayoutRun(rows[0].data)).stepCount,7);
  assert.equal(typeof rows[0].writeId,'string');
});

test('expired-row cleanup that races a newer put of the same runId keeps the newer row',async()=>{
  let clock=1_000_000;const now=()=>clock,idb=serialIndexedDB(),f=await fixture();
  await createLayoutRunStore({indexedDB:idb,now}).put(f,{consent:true});
  const reader=createLayoutRunStore({indexedDB:idb,now}),writer=createLayoutRunStore({indexedDB:idb,now});
  await reader.list();await writer.list();                // open both while the row is still fresh
  clock+=LAYOUT_RUN_TTL_MS;assert.equal(runRows(idb).length,1);
  idb.pause();const base=idb.created;
  const got=reader.get('run-1');await until(()=>idb.created>=base+1);       // reads the expired row
  const put=writer.put({...f,stepCount:8},{consent:true});await until(()=>idb.created>=base+2);
  idb.resume();
  assert.equal(await got,null);assert.equal((await put).persisted,true);
  const rows=runRows(idb);assert.equal(rows.length,1);assert.equal((await decodeLayoutRun(rows[0].data)).stepCount,8);
  // A legacy row without writeId is still removed by its own cleanup once expired.
  idb.dbs.get(LAYOUT_RUN_DB_NAME).get('runs').rows.set('run-1',{...rows[0],writeId:undefined});
  clock+=LAYOUT_RUN_TTL_MS;assert.equal(await createLayoutRunStore({indexedDB:idb,now}).get('run-1'),null);assert.equal(runRows(idb).length,0);
});

function gateProjects(){
  let armed=false,release=null;const entered=[];
  return {entered,arm(){armed=true;},async hold(){await until(()=>entered.includes('held'));},release(){release?.();},
    create:async spec=>{if(armed){armed=false;await new Promise(r=>{release=r;entered.push('held');});}return createLatexProject(spec);}};
}
test('the last invoked save wins when an earlier validation finishes later',async()=>{
  const older=await fixture({runState:'paused'}),newer=await fixture({runState:'completed'});
  const idb=serialIndexedDB(),store=createLayoutRunStore({indexedDB:idb});
  await store.setConsent(true);
  await store.put({...older,stepCount:5},{consent:true});
  await store.put({...newer,runId:older.runId,stepCount:9},{consent:true});
  assert.equal((await store.get(older.runId)).stepCount,9,'sequential saves keep the later snapshot');
  const gate=gateProjects(),raced=serialIndexedDB(),racer=createLayoutRunStore({indexedDB:raced,createLatexProject:gate.create});
  await racer.setConsent(true);
  const slowOlder=await fixture({runId:'race-run',runState:'paused'}),fastNewer=await fixture({runId:'race-run',runState:'completed'});
  gate.arm();
  const slow=racer.put({...slowOlder,stepCount:5},{consent:true});
  await gate.hold();
  const fast=await racer.put({...fastNewer,stepCount:9},{consent:true});
  gate.release();
  const slowResult=await slow;
  assert.equal(fast.persisted,true);assert.equal(slowResult.persisted,false);
  assert.equal((await racer.get('race-run')).stepCount,9);assert.equal((await racer.get('race-run')).runState,'completed');
  assert.equal((await createLayoutRunStore({indexedDB:raced}).get('race-run')).stepCount,9);
  assert.equal((await createLayoutRunStore({indexedDB:raced}).get('race-run')).candidate.artifact.pdfHash,fastNewer.candidate.artifact.pdfHash);
});

test('an issued valid save remains when a later invalid save only takes the claim',async()=>{
  const gate=gateProjects(),idb=serialIndexedDB(),store=createLayoutRunStore({indexedDB:idb,now:()=>1000,createLatexProject:gate.create});
  await store.setConsent(true);
  const good=await fixture({runId:'same-run',runState:'paused'});
  idb.pause();const base=idb.created;
  const saved=store.put(good);
  await until(()=>idb.created>=base+1);
  const bad={...good,baselineProject:{...good.baselineProject,id:'b'.repeat(64)}};
  gate.arm();
  const rejected=assert.rejects(store.put(bad),/Invalid or mismatched layout run/);
  await gate.hold();
  idb.resume();
  const result=await saved;
  gate.release();
  await rejected;
  assert.equal(result.persisted,false);
  const rows=runRows(idb);assert.equal(rows.length,1);
  const fresh=await createLayoutRunStore({indexedDB:idb,now:()=>1000}).get('same-run');
  assert.equal(fresh.currentProject.id,good.currentProject.id);
  assert.equal(fresh.baselineProject.id,good.baselineProject.id);
});

test('a later valid save issued after an earlier queued save still replaces that row',async()=>{
  const idb=serialIndexedDB(),store=createLayoutRunStore({indexedDB:idb});
  await store.setConsent(true);
  const older=await fixture({runId:'race-issued',runState:'paused'}),newer=await fixture({runId:'race-issued',runState:'completed'});
  idb.pause();const base=idb.created;
  const slow=store.put({...older,stepCount:5});
  await until(()=>idb.created>=base+1);
  const fast=store.put({...newer,stepCount:9});
  await until(()=>idb.created>=base+2);
  idb.resume();
  const [slowResult,fastResult]=await Promise.all([slow,fast]);
  assert.equal(slowResult.persisted,false);assert.equal(fastResult.persisted,true);
  const rows=runRows(idb);assert.equal(rows.length,1);assert.equal((await decodeLayoutRun(rows[0].data)).stepCount,9);
  assert.equal((await createLayoutRunStore({indexedDB:idb}).get('race-issued')).stepCount,9);
});

test('clear and dispose discard a save that is still validating',async()=>{
  const gate=gateProjects(),idb=serialIndexedDB(),store=createLayoutRunStore({indexedDB:idb,createLatexProject:gate.create}),f=await fixture();
  await store.setConsent(true);gate.arm();
  const pending=store.put({...f,stepCount:4},{consent:true});
  await gate.hold();await store.clear();gate.release();
  assert.equal((await pending).persisted,false);assert.equal(await store.get('run-1'),null);assert.equal(idb.rows(LAYOUT_RUN_DB_NAME,'runs').length,0);
  const gate2=gateProjects(),idb2=serialIndexedDB(),store2=createLayoutRunStore({indexedDB:idb2,createLatexProject:gate2.create}),f2=await fixture({runId:'run-dispose'});
  await store2.setConsent(true);gate2.arm();
  const pending2=store2.put(f2,{consent:true});
  await gate2.hold();store2.dispose();gate2.release();
  assert.equal((await pending2).persisted,false);
  assert.equal(await createLayoutRunStore({indexedDB:idb2}).get('run-dispose'),null);
});

test('outcome scope, limitations and coverage survive the run codec',async()=>{
  const f=await fixture();const quality={...f.quality,layout:'clear',findings:[],layoutScope:'observed',layoutVerified:false,inspectionStatus:'partial',limitations:['Findings truncated.','Heading could not be uniquely observed.'],coverage:{pages:2,findingsTruncated:true}};
  const out=await decodeLayoutRun(await encodeLayoutRun({...f,quality}));assert.deepEqual(out.quality,quality);
});