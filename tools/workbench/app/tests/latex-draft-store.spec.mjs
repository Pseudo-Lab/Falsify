import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexDraftStore} from '../src/latex-draft-store.mjs';
import {LAYOUT_RUN_TTL_MS} from '../src/paper-layout-run-store.mjs';
import {serialIndexedDB,until} from './serial-indexeddb.mjs';

// F6: IndexedDB transactions are serialized in creation order; these cases order a
// stale write's rollback or cleanup after a newer re-consented draft.
const DB='falsify-latex-drafts';
const current=idb=>new Map(idb.rows(DB,'drafts')).get('current');

test('opt-in only, memory fallback and twelve-hour expiry are preserved',async()=>{
  let clock=1_000;const now=()=>clock,idb=serialIndexedDB(),store=createLatexDraftStore({indexedDB:idb,now});
  assert.deepEqual(await store.put('private',{consent:false}),{persisted:false});assert.equal(await store.get(),null);assert.equal(current(idb),undefined,'nothing persisted without consent');
  const r=await store.put('draft-1',{consent:true});assert.equal(r.persisted,true);assert.equal(current(idb).archive,'draft-1');
  assert.equal(typeof current(idb).writeId,'string');
  assert.equal((await createLatexDraftStore({indexedDB:idb,now}).get()).archive,'draft-1','survives reload');
  clock+=LAYOUT_RUN_TTL_MS;assert.equal(await createLatexDraftStore({indexedDB:idb,now}).get(),null);assert.equal(current(idb),undefined,'expired draft removed');
  const offline=createLatexDraftStore({indexedDB:null,now});const o=await offline.put('tab only',{consent:true});
  assert.equal(o.persisted,false);assert.ok(o.storageError);assert.equal((await offline.get()).archive,'tab only');
});

test('late withdrawal rollback never deletes the newer re-consented draft',async()=>{
  const idb=serialIndexedDB(),store=createLatexDraftStore({indexedDB:idb});
  await store.put('warm',{consent:true});
  idb.pause();const base=idb.created;
  const a=store.put('A',{consent:true});await until(()=>idb.created>=base+1);   // write A queued
  const cleared=store.clear();await until(()=>idb.created>=base+2);             // withdrawal queued after A
  const b=store.put('B',{consent:true});await until(()=>idb.created>=base+3);   // re-consented write B
  idb.resume();
  assert.equal((await a).persisted,false);assert.equal((await cleared).cleared,true);assert.equal((await b).persisted,true);
  assert.equal(current(idb).archive,'B');
  assert.equal((await createLatexDraftStore({indexedDB:idb}).get()).archive,'B','newer draft survives reload');
});

test('a write withdrawn before it is issued is never queued',async()=>{
  const idb=serialIndexedDB(),store=createLatexDraftStore({indexedDB:idb});
  const a=store.put('A',{consent:true});const cleared=store.clear();const b=store.put('B',{consent:true});
  const [ra,,rb]=await Promise.all([a,cleared,b]);
  assert.equal(ra.persisted,false);assert.equal(rb.persisted,true);assert.equal(current(idb).archive,'B');
});

test('expired-draft cleanup racing a newer draft keeps the newer one; legacy rows still expire',async()=>{
  let clock=1_000;const now=()=>clock,idb=serialIndexedDB();
  await createLatexDraftStore({indexedDB:idb,now}).put('old',{consent:true});
  const reader=createLatexDraftStore({indexedDB:idb,now}),writer=createLatexDraftStore({indexedDB:idb,now});
  clock+=LAYOUT_RUN_TTL_MS;
  idb.pause();const base=idb.created;
  const got=reader.get();await until(()=>idb.created>=base+1);                 // reads the expired row
  const put=writer.put('new',{consent:true});await until(()=>idb.created>=base+2);
  idb.resume();
  assert.equal(await got,null);assert.equal((await put).persisted,true);assert.equal(current(idb).archive,'new');
  const legacy={archive:'legacy',consent:true,savedAt:clock};idb.dbs.get(DB).get('drafts').rows.set('current',legacy);
  clock+=LAYOUT_RUN_TTL_MS;assert.equal(await createLatexDraftStore({indexedDB:idb,now}).get(),null);assert.equal(current(idb),undefined);
});
