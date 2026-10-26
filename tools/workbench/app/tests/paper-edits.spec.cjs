const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const E=require('../dist/paper-edits.js');
const HASH='a'.repeat(64),OTHER='b'.repeat(64),NOW=1700000000000;
let passed=0;const checks=[];
function check(name,fn){fn();checks.push(name);passed++;}
const seg=(id,text,pageIndex)=>({id,label:'PDF p. '+(pageIndex+1),text,pageIndex});
function session(segments,over={}){return E.create({fileHash:HASH,name:'synthetic.txt',segments,now:NOW,...over});}
function edit(over={}){return {pageIndex:0,segmentId:'s0',before:'unique claim',after:'altered claim',origin:'human',...over};}

check('update then undo then redo keeps the original Before and final After',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const id=s.add(edit());
  assert.equal(id,'e1');
  s.update(id,{after:'second claim'});
  let snap=s.snapshot();
  assert.equal(snap.schema,E.SCHEMA);
  assert.deepEqual(Object.keys(snap),['schema','fileHash','name','revision','edits','canUndo','canRedo']);
  assert.equal(snap.revision,2);assert.equal(snap.canUndo,true);assert.equal(snap.canRedo,false);
  assert.equal(snap.edits[0].before,'unique claim');assert.equal(snap.edits[0].after,'second claim');
  assert.equal(snap.edits[0].history[0].after,'altered claim');assert.equal(snap.edits[0].history[1].after,'second claim');
  assert.equal(snap.edits[0].history[0].revision,1);assert.equal(snap.edits[0].history[1].revision,2);
  s.undo();snap=s.snapshot();
  assert.equal(snap.revision,1);assert.equal(snap.edits[0].before,'unique claim');assert.equal(snap.edits[0].after,'altered claim');
  assert.equal(snap.edits[0].history.length,1);assert.equal(snap.canRedo,true);
  s.redo();snap=s.snapshot();
  assert.equal(snap.revision,2);assert.equal(snap.edits[0].after,'second claim');assert.equal(snap.edits[0].before,'unique claim');
  assert.equal(snap.edits[0].history.length,2);assert.equal(snap.edits[0].origin,'human');
});

check('history keeps the first After and drops the middle past the cap',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const id=s.add(edit());
  const first=s.snapshot().edits[0].history[0];
  for(let i=0;i<E.LIMITS.maxHistory+3;i++)s.update(id,{after:'claim '+i+' v'});
  const row=s.snapshot().edits[0];
  assert.equal(row.history.length,E.LIMITS.maxHistory);
  assert.equal(row.before,'unique claim');
  assert.deepEqual(row.history[0],first);
  assert.equal(row.after,'claim '+(E.LIMITS.maxHistory+2)+' v');
  assert.equal(row.history.at(-1).after,row.after);
  s.undo();
  assert.equal(s.snapshot().edits[0].before,'unique claim');
  assert.equal(s.snapshot().edits[0].after,'claim '+(E.LIMITS.maxHistory+1)+' v');
});

check('enable and remove participate in undo and redo',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const id=s.add(edit()),seen=[];
  const unsub=s.subscribe(snap=>seen.push(snap));
  s.setEnabled(id,false);
  assert.equal(s.snapshot().edits[0].enabled,false);assert.equal(s.snapshot().edits[0].history.at(-1).enabled,false);
  s.undo();assert.equal(s.snapshot().edits[0].enabled,true);
  s.redo();assert.equal(s.snapshot().edits[0].enabled,false);
  s.setEnabled(id,false);assert.equal(s.snapshot().revision,2,'same enabled value does not move revision');
  s.remove(id);assert.deepEqual(s.snapshot().edits,[]);assert.equal(s.snapshot().canUndo,true);
  s.undo();assert.equal(s.snapshot().edits[0].id,id);assert.equal(s.snapshot().edits[0].enabled,false);
  s.redo();assert.equal(s.snapshot().edits.length,0);
  unsub();s.undo();assert.equal(seen.length,6);
});

check('a new edit after undo invalidates redo and does not reuse that revision',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const id=s.add(edit());
  s.update(id,{after:'second claim'});s.undo();
  assert.equal(s.snapshot().canRedo,true);assert.equal(s.snapshot().revision,1);
  s.update(id,{after:'third claim'});
  const snap=s.snapshot();
  assert.equal(snap.canRedo,false);assert.equal(snap.revision,3);assert.equal(snap.edits[0].after,'third claim');
  assert.throws(()=>s.redo(),e=>e.code==='redo-empty'&&e.paperEdits===true);
  assert.equal(s.snapshot().edits[0].after,'third claim');assert.equal(s.snapshot().edits[0].before,'unique claim');
});

check('duplicate text is not anchored at the first hit',()=>{
  const text='alpha beta alpha';
  const s=session([seg('s0',text,0),seg('s1','alpha only here',1)]);
  const base={pageIndex:0,segmentId:'s0',before:'alpha',after:'omega',origin:'human'};
  assert.throws(()=>s.add(base),e=>e.code==='duplicate-anchor');
  assert.throws(()=>s.add({...base,anchor:{bbox:[0,0,12,8]}}),e=>e.code==='duplicate-anchor');
  assert.equal(s.snapshot().revision,0);
  const first=s.add({...base,anchor:{occurrence:0,bbox:[1,2,11,8],style:{font:'Times',size:10.5,color:0x112233}}});
  const second=s.add({...base,anchor:{start:11,end:16}});
  const snap=s.snapshot();
  assert.deepEqual(snap.edits.map(e=>[e.id,e.anchor.start,e.anchor.end,e.anchor.occurrence]),[[first,0,5,0],[second,11,16,1]]);
  assert.deepEqual(snap.edits[0].anchor.bbox,[1,2,11,8]);assert.equal(snap.edits[0].anchor.style.font,'Times');
  assert.throws(()=>s.add({...base,anchor:{occurrence:2}}),e=>e.code==='invalid');
  assert.throws(()=>s.add({pageIndex:0,before:'alpha',after:'omega',origin:'external-ai-import'}),e=>e.code==='duplicate-anchor');
  assert.throws(()=>s.add({...base,anchor:{occurrence:0}}),e=>e.code==='overlap');
});

check('unknown ids do not change revision or notify',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  let calls=0;s.subscribe(()=>{calls++;});
  s.add(edit());calls=0;
  for(const act of [()=>s.update('missing',{after:'other claim'}),()=>s.remove('e9'),()=>s.setEnabled('e9',false)])assert.throws(act,e=>e.code==='unknown-id');
  assert.equal(calls,0);assert.equal(s.snapshot().revision,1);assert.equal(s.snapshot().edits.length,1);
});

check('human and imported edits may change numbers and citations',()=>{
  const before='The rate was 0.04 in the treated cohort [12] (https://example.test/a).';
  const after='The rate was 0.40 in every cohort [3] (https://example.test/b).';
  const s=session([seg('s0',before,0)]);
  for(const origin of ['human','external-ai-import','ai-proposal']){
    const id=s.add({pageIndex:0,segmentId:'s0',before,after,origin});
    const row=s.snapshot().edits.find(e=>e.id===id);
    assert.equal(row.origin,origin);assert.equal(row.before,before);assert.equal(row.after,after);
    s.remove(id);
  }
  assert.equal(s.snapshot().edits.length,0);
});

check('drafts bind the file hash and a 12 hour TTL',()=>{
  const marker='SEGMENT-ONLY-MARKER';
  const s=session([seg('s0','unique claim '+marker,0)]);
  const id=s.add(edit({anchor:{occurrence:0}}));
  const env=E.draft({snapshot:s.snapshot(),now:NOW});
  assert.equal(env.schema,E.DRAFT_SCHEMA);assert.equal(env.fileHash,HASH);
  assert.equal(env.expiresAt-env.savedAt,E.TTL_MS);assert.equal(E.TTL_MS,12*60*60*1000);
  assert.equal(JSON.stringify(env).includes(marker),false);
  assert.equal(JSON.stringify(env).includes('token'),false);
  const copy=JSON.parse(JSON.stringify(env));
  env.snapshot.edits[0].after='mutated envelope';
  assert.equal(s.snapshot().edits[0].after,'altered claim');
  assert.equal(copy.snapshot.edits[0].after,'altered claim');
  assert.throws(()=>E.restoreDraft(env,{fileHash:HASH,now:NOW+1}),e=>e.code==='malformed');
  const restored=E.restoreDraft(copy,{fileHash:HASH,now:NOW+E.TTL_MS-1});
  assert.equal(restored.edits[0].id,id);assert.equal(restored.revision,1);
  restored.edits[0].before='tamper';
  assert.equal(E.restoreDraft(JSON.stringify(copy),{fileHash:HASH,now:NOW+1}).edits[0].before,'unique claim');
  assert.throws(()=>E.restoreDraft(copy,{fileHash:OTHER,now:NOW+1}),e=>e.code==='hash-mismatch');
  const wrong=JSON.parse(JSON.stringify(copy));wrong.fileHash=OTHER;
  assert.throws(()=>E.restoreDraft(wrong,{fileHash:HASH,now:NOW+1}),e=>e.code==='hash-mismatch');
  assert.throws(()=>E.restoreDraft(copy,{fileHash:HASH,now:NOW+E.TTL_MS}),e=>e.code==='expired');
  assert.throws(()=>E.restoreDraft('{',{fileHash:HASH,now:NOW}),e=>e.code==='malformed');
  assert.throws(()=>E.restoreDraft(null,{fileHash:HASH,now:NOW}),e=>e.code==='malformed');
  const cred=JSON.parse(JSON.stringify(copy));cred.snapshot.token='sekret';
  assert.throws(()=>E.restoreDraft(cred,{fileHash:HASH,now:NOW+1}),e=>e.code==='malformed');
  const extra=JSON.parse(JSON.stringify(copy));extra.password='nope';
  assert.throws(()=>E.restoreDraft(extra,{fileHash:HASH,now:NOW+1}),e=>e.code==='malformed');
  const badTime=JSON.parse(JSON.stringify(copy));badTime.expiresAt=badTime.savedAt+1000;
  assert.throws(()=>E.restoreDraft(badTime,{fileHash:HASH,now:NOW+1}),e=>e.code==='malformed');
  const resumed=session([seg('s0','unique claim '+marker,0)],{resume:E.restoreDraft(copy,{fileHash:HASH,now:NOW+5})});
  assert.equal(resumed.snapshot().edits[0].id,id);assert.equal(resumed.snapshot().canUndo,false);
  assert.equal(resumed.snapshot().revision,1);assert.equal(s.snapshot().edits[0].after,'altered claim');
  resumed.update(id,{after:'resumed claim'});
  assert.equal(resumed.snapshot().edits[0].before,'unique claim');assert.equal(s.snapshot().revision,1);
});

check('clones and sessions do not share mutable aliases',()=>{
  const segments=[seg('s0','unique claim in the source',0)];
  const a=session(segments),b=session(segments.map(s=>({...s})));
  const input=edit({anchor:{bbox:[1,2,20,9]}});
  const id=a.add(input);
  input.after='hacked';input.anchor.bbox[0]=99;segments[0].text='rewritten source';segments.push(seg('s1','another claim',1));
  const first=a.snapshot(),second=a.snapshot();
  first.edits[0].after='alias';first.edits[0].anchor.bbox[0]=50;first.edits.push({id:'x'});first.history=[{}];
  assert.equal(second.edits[0].after,'altered claim');assert.equal(second.edits[0].anchor.bbox[0],1);assert.equal(second.edits.length,1);
  assert.equal(a.snapshot().edits[0].after,'altered claim');assert.equal(a.snapshot().edits[0].before,'unique claim');
  let left,right;a.subscribe(snap=>{left=snap;});a.subscribe(snap=>{right=snap;});
  a.setEnabled(id,false);
  assert.notEqual(left,right);left.edits[0].after='subscriber alias';
  assert.equal(right.edits[0].after,'altered claim');assert.equal(a.snapshot().edits[0].after,'altered claim');
  assert.equal(b.snapshot().edits.length,0);assert.equal(b.snapshot().revision,0);
  b.add(edit({after:'other session'}));
  assert.equal(a.snapshot().edits.length,1);assert.equal(b.snapshot().edits[0].after,'other session');
});

check('non-finite, unknown and unbounded input is rejected',()=>{
  const good=[seg('s0','unique claim in the source',0)];
  assert.throws(()=>session(good,{fileHash:'A'.repeat(64)}));
  assert.throws(()=>session(good,{name:'  padded'}));
  assert.throws(()=>session([{...good[0],pageIndex:1.5}]));
  assert.throws(()=>session([{...good[0],pageIndex:Number.POSITIVE_INFINITY}]));
  const s=session(good);
  assert.throws(()=>s.add(edit({after:'unique claim'})));
  assert.throws(()=>s.add(edit({origin:'manual-unverified'})));
  assert.throws(()=>s.add(edit({pageIndex:1})));
  assert.throws(()=>s.add({...edit(),token:'x'}));
  assert.throws(()=>s.add(edit({anchor:{occurrence:0,bbox:[0,0,Infinity,2]}})));
  assert.throws(()=>s.add(edit({before:'missing quote'})));
  assert.throws(()=>s.undo(),e=>e.code==='undo-empty');
  assert.throws(()=>s.redo(),e=>e.code==='redo-empty');
  assert.throws(()=>s.subscribe(null));
  const id=s.add(edit());
  assert.throws(()=>s.update(id,{before:'unique claim'}));
  assert.throws(()=>s.update(id,{after:'unique claim'}));
  assert.throws(()=>s.update(id,{anchor:{start:0,end:1}}));
  assert.throws(()=>s.setEnabled(id,'false'));
  const many=Array.from({length:E.LIMITS.maxEdits+1},(_,i)=>seg('s'+i,'word'+i+' tail',i));
  const full=session(many);
  for(let i=0;i<E.LIMITS.maxEdits;i++)full.add({pageIndex:i,segmentId:'s'+i,before:'word'+i,after:'WORD'+i,origin:'human'});
  assert.throws(()=>full.add({pageIndex:E.LIMITS.maxEdits,segmentId:'s'+E.LIMITS.maxEdits,before:'word'+E.LIMITS.maxEdits,after:'WORD',origin:'human'}));
});

check('empty After deletes the quote and still round-trips',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const id=s.add(edit({after:''}));
  let row=s.snapshot().edits[0];
  assert.equal(row.before,'unique claim');assert.equal(row.after,'');assert.equal(row.history[0].after,'');
  s.update(id,{after:'restored words'});
  s.update(id,{after:''});
  row=s.snapshot().edits[0];
  assert.equal(row.after,'');assert.equal(row.before,'unique claim');assert.equal(row.history.at(-1).after,'');
  assert.throws(()=>s.add(edit()),e=>e.code==='overlap');
  assert.throws(()=>s.update(id,{after:'unique claim'}),e=>e.code==='invalid');
  assert.throws(()=>s.update(id,{after:''}),e=>e.code==='invalid');
  assert.throws(()=>session([seg('s0','unique claim',0)]).add(edit({before:'',after:'x'})));
  const env=E.draft({snapshot:s.snapshot(),now:NOW});
  const restored=E.restoreDraft(JSON.stringify(env),{fileHash:HASH,now:NOW+1});
  assert.equal(restored.edits[0].after,'');assert.equal(restored.edits[0].history.at(-1).after,'');
  const resumed=session([seg('s0','unique claim in the source',0)],{resume:restored});
  assert.equal(resumed.snapshot().edits[0].after,'');assert.equal(resumed.snapshot().edits[0].before,'unique claim');
});

check('a failing listener does not hide the committed edit from the next listener',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const errors=[];let second=0;
  s.subscribe(()=>{throw new Error('listener failed');},error=>{errors.push(error);throw new Error('callback failed');});
  s.subscribe(()=>{second++;});
  const id=s.add(edit());
  assert.equal(id,'e1');assert.equal(second,1);assert.equal(errors.length,1);assert.equal(errors[0].message,'listener failed');
  assert.equal(s.snapshot().edits[0].id,id);assert.equal(s.snapshot().revision,1);
  assert.doesNotThrow(()=>s.update(id,{after:'still committed'}));
  assert.equal(second,2);assert.equal(s.snapshot().edits[0].after,'still committed');
});

check('failed adds do not consume ids and remove/re-add stays available',()=>{
  const s=session([seg('s0','alpha beta alpha',0),seg('s1','other unique quote',0)]);
  const first=s.add({pageIndex:0,segmentId:'s0',before:'alpha',after:'A',origin:'human',anchor:{occurrence:0}});
  assert.equal(first,'e1');
  for(let i=0;i<40;i++)assert.throws(()=>s.add({pageIndex:0,segmentId:'s0',before:'alpha',after:'B',origin:'human',anchor:{occurrence:0}}),e=>e.code==='overlap');
  const second=s.add({pageIndex:0,segmentId:'s1',before:'other unique quote',after:'changed quote',origin:'human'});
  assert.equal(second,'e2');
  const cycle=session([seg('s0','unique claim in the source',0)]);
  let last;
  for(let i=0;i<321;i++){last=cycle.add(edit());cycle.remove(last);}
  assert.equal(last,'e321');
  assert.equal(cycle.add(edit()),'e322');
  assert.equal(cycle.snapshot().edits.length,1);
});

check('discovered paragraphs preserve undo history and bind exact immutable source',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  const first=s.add(edit());s.update(first,{after:'second claim'});s.undo();
  const before=s.snapshot();let calls=0;s.subscribe(()=>calls++);
  const incoming=seg('paragraph-1','Another source paragraph.',1);
  assert.equal(s.addSegments([incoming]),1);
  incoming.text='Mutated caller copy';
  assert.deepEqual(s.snapshot(),before);assert.equal(calls,0);
  assert.equal(s.addSegments([seg('paragraph-1','Another source paragraph.',1)]),0);
  s.redo();assert.equal(s.snapshot().edits[0].after,'second claim');
  s.add({segmentId:'paragraph-1',pageIndex:1,before:'Another source paragraph.',after:'Another edited paragraph.',origin:'human'});
  assert.equal(s.snapshot().edits[1].before,'Another source paragraph.');
  assert.equal(s.snapshot().edits[1].anchor.start,0);
  assert.equal(s.snapshot().edits[1].origin,'human');
});

check('paragraph discovery rejects a conflicting batch atomically and enforces combined limits',()=>{
  const s=session([seg('s0','unique claim in the source',0)]);
  assert.throws(()=>s.addSegments([seg('new','New text',1),seg('s0','Different source',0)]),e=>e.code==='segment-conflict');
  assert.throws(()=>s.add({pageIndex:1,segmentId:'new',before:'New text',after:'Changed text',origin:'human'}),e=>e.code==='invalid');
  assert.equal(s.snapshot().revision,0);
  assert.throws(()=>s.addSegments([seg('bad','text',-1)]),e=>e.code==='invalid');
  const full=session(Array.from({length:E.LIMITS.maxSegments},(_,i)=>seg('p'+i,'a',0)));
  assert.throws(()=>full.addSegments([seg('extra','b',0)]),e=>e.code==='invalid');
  assert.equal(full.snapshot().revision,0);
  const unpaged=session([{id:'original',label:'Text',text:'Before text'}]);
  assert.equal(unpaged.addSegments([seg('paged','Page text',1)]),1);
  assert.equal(unpaged.addSegments([{id:'original',label:'Text',text:'Before text'}]),0);
});

check('browser global export does not touch storage, DOM or network',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../dist/paper-edits.js'),'utf8');
  for(const banned of ['localStorage','sessionStorage','indexedDB','XMLHttpRequest','WebSocket','fetch(','document.','window.'])assert.equal(code.includes(banned),false,banned);
  assert.equal(globalThis.FalsifyPaperEdits,undefined);
  const sandbox={};sandbox.globalThis=sandbox;
  vm.runInNewContext(code+`
    const s=FalsifyPaperEdits.create({fileHash:${JSON.stringify(HASH)},name:'synthetic.txt',segments:[{id:'s0',label:'PDF p. 1',text:'unique claim',pageIndex:0}]});
    s.add({pageIndex:0,segmentId:'s0',before:'unique claim',after:'altered claim',origin:'human'});
    const env=FalsifyPaperEdits.draft({snapshot:s.snapshot(),now:${NOW}});
    if(FalsifyPaperEdits.restoreDraft(env,{fileHash:${JSON.stringify(HASH)},now:${NOW+1}}).edits.length!==1) throw new Error('draft');
    if(typeof localStorage!=='undefined'||typeof document!=='undefined'||typeof fetch!=='undefined') throw new Error('host');
  `,sandbox,{filename:'paper-edits.js'});
  assert.equal(typeof sandbox.FalsifyPaperEdits.create,'function');
  assert.equal(sandbox.localStorage,undefined);assert.equal(sandbox.document,undefined);assert.equal(sandbox.fetch,undefined);
});

try{console.log(JSON.stringify({passed,checks},null,2));}
catch(e){console.error(e);process.exitCode=1;}
