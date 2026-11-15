'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const TAX=require('../dist/adversarial-taxonomy.js');
const CORE=require('../dist/document-red-core.js');
const CORE_SRC=fs.readFileSync(path.resolve(__dirname,'../dist/document-red-core.js'),'utf8');
const RED_SRC=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');

const PATCH_KEYS=['id','segmentId','label','before','after','offset','edited'];

function element(id){
  const e=new EventTarget(),classes=new Set();
  Object.assign(e,{
    id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],className:'',type:'',
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},
    after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[],
  });
  return e;
}

function mountDocumentRed(){
  const els=new Map(),created=[],downloads=[],exportCalls=[];
  const get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);};
  const document=new EventTarget();
  Object.assign(document,{
    scripts:[],
    querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,
    querySelectorAll:()=>[],
    createElement:tag=>{const e=element('');e.tagName=tag;created.push(e);return e;},
    body:element('body'),
  });
  get('red-level').value='1';
  get('red-budget').value='4';
  get('red-harness').value='h1';
  get('document-red').hidden=true;
  const crypto={
    randomUUID:()=>'u-'+Math.random().toString(16).slice(2),
    subtle:{digest:async()=>new Uint8Array(32).buffer},
  };
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>'run-1'};
  const bridge={busy(){},session:()=>null,state:()=>({status:'manual',connected:false,cap:null}),capabilities:()=>({red:true,pdf:false})};
  const falsifyExport={
    async textFile(file,patches){exportCalls.push(patches);return {bytes:new Uint8Array(Buffer.from('ok')),verification:{status:'passed'}};},
  };
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const ctx=vm.createContext({
    document,crypto,FalsifyAdversarialTaxonomy:TAX,FalsifyDocumentRed:CORE,
    FalsifyHarness:require('../dist/harness-core.js'),FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:falsifyExport,
    TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,
    addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object,
  });
  vm.runInContext(RED_SRC,ctx,{filename:'document-red.js'});
  return {document,get,created,downloads,exportCalls};
}

const flush=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

test('taxonomy v2 exports expected attack types, families, surfaces, and levels',()=>{
  assert.equal(TAX.SCHEMA,'falsify.adversarial-taxonomy.v2');
  assert.deepEqual(TAX.ATTACK_TYPES,[
    'contradiction','condition-omission','unsupported-inference',
    'numeric-drift','citation-distortion','outcome-status-mislabeling','semantic-inversion',
  ]);
  assert.deepEqual(Object.keys(TAX.FAMILIES),['D1','D2','D3','D4-1','S1']);
  assert.equal(TAX.FAMILIES.D1.oracleSource,'internal-table-figure-math');
  assert.equal(TAX.FAMILIES.D2.oracleSource,'bib-db-and-pdf-uri');
  assert.equal(TAX.FAMILIES.D3.oracleSource,'internal-methods-results');
  assert.equal(TAX.FAMILIES['D4-1'].oracleSource,'external-registry-protocol');
  assert.equal(TAX.FAMILIES.S1.oracleSource,'domain-mechanism-definition');
  assert.deepEqual(TAX.SURFACES,['prose','table','chart','citation','registry']);
  assert.deepEqual(Object.keys(TAX.LEVELS),['1','2','3','4']);
  assert.equal(TAX.familyForAttackType('numeric-drift'),'D1');
  assert.equal(TAX.familyForAttackType('citation-distortion'),'D2');
  assert.equal(TAX.familyForAttackType('contradiction'),'D3');
  assert.equal(TAX.familyForAttackType('outcome-status-mislabeling'),'D4-1');
  assert.equal(TAX.familyForAttackType('semantic-inversion'),'S1');
  assert.equal(TAX.familyForAttackType('unknown'),null);
});

test('inferSurface and classifyDefect cover explicit types and heuristic fallbacks',()=>{
  assert.equal(TAX.inferSurface({kind:'table-cell',attackTypes:['numeric-drift']}),'table');
  assert.equal(TAX.inferSurface({kind:'chart-point',attackTypes:['numeric-drift']}),'chart');
  assert.equal(TAX.inferSurface({attackTypes:['citation-distortion']}),'citation');
  assert.equal(TAX.inferSurface({attackTypes:['outcome-status-mislabeling']}),'registry');
  assert.equal(TAX.inferSurface({attackTypes:['contradiction']}),'prose');

  assert.deepEqual(TAX.classifyDefect({attackTypes:['numeric-drift'],kind:'table-cell'}),{
    defectFamily:'D1',attackTypes:['numeric-drift'],oracleSource:'internal-table-figure-math',surface:'table',
  });
  assert.deepEqual(TAX.classifyDefect({before:'See prior work [12].',after:'See prior work [99].'}),{
    defectFamily:'D2',attackTypes:['citation-distortion'],oracleSource:'bib-db-and-pdf-uri',surface:'citation',
  });
  assert.deepEqual(TAX.classifyDefect({before:'Reported p = 0.21 in cohort.',after:'Reported p = 0.01 in cohort.'}),{
    defectFamily:'D1',attackTypes:['numeric-drift'],oracleSource:'internal-table-figure-math',surface:'prose',
  });
  assert.deepEqual(TAX.classifyDefect({before:'Exploratory endpoint in NCT01234567.',after:'Pre-specified primary outcome in NCT01234567.'}),{
    defectFamily:'D4-1',attackTypes:['outcome-status-mislabeling'],oracleSource:'external-registry-protocol',surface:'registry',
  });
  assert.deepEqual(TAX.classifyDefect({before:'Enriched H3K27me3 at promoter.',after:'Enriched H3K4me3 at promoter.'}),{
    defectFamily:'S1',attackTypes:['semantic-inversion'],oracleSource:'domain-mechanism-definition',surface:'prose',
  });
});

test('scanBlindnessLeaks detects English, Korean, metadata, and filename leaks without false positives on source matches',()=>{
  for(const phrase of [
    'Contains 5 intentional errors in methods.',
    'This includes an injected defect for evaluation.',
    'Planted flaw in table 2.',
    'Compare against the answer key.',
    'This is a tampered copy of the paper.',
    'red_team_injected marker',
    '의도적 오류를 포함한 문장입니다.',
    '이 파일은 변조본입니다.',
    '주입된 결함 확인',
    '결함 5개 포함',
    '정답지 참고',
  ]){
    const res=TAX.scanBlindnessLeaks(phrase);
    assert.equal(res.clean,false,'expected leak for: '+phrase);
    assert.ok(res.issues.length>=1);
  }
  assert.equal(TAX.scanBlindnessLeaks({metadata:{title:'falsify-red-copy'}}).clean,false);
  assert.equal(TAX.scanBlindnessLeaks({filename:'paper-tampered.pdf'}).clean,false);
  assert.equal(TAX.scanBlindnessLeaks({filename:'논문_정답.pdf'}).clean,false);
  assert.equal(TAX.scanBlindnessLeaks({
    candidates:[{before:'Baseline had 5 intentional errors.',after:'Baseline had 5 intentional errors in group B.'}],
  }).clean,true);
  assert.equal(TAX.scanBlindnessLeaks({
    text:'Patients received 50 mg daily (p = 0.03).',
    candidates:[{before:'p = 0.03',after:'p = 0.30'}],
    metadata:{title:'Clinical Trial Analysis'},
    filename:'trial-2026.pdf',
  }).clean,true);
});

test('document-red-core preserves legacy L1..L3, adds L4 + 7 types, W5 policy, and standalone VM fallback',()=>{
  assert.deepEqual(CORE.TYPES,TAX.ATTACK_TYPES);
  assert.deepEqual(CORE.types(1),['contradiction']);
  assert.deepEqual(CORE.types(2),['condition-omission']);
  assert.deepEqual(CORE.types(3),['unsupported-inference']);
  assert.deepEqual(CORE.types(4),['contradiction','condition-omission','unsupported-inference','numeric-drift']);
  assert.ok(CORE.FAMILIES.D1&&CORE.FAMILIES['D4-1']&&CORE.FAMILIES.S1);
  assert.equal(typeof CORE.scanBlindnessLeaks,'function');

  const doc={revision:'r1',sourceHash:'h1',segments:[{id:'s0',label:'p1',text:'Marker H3K27me3 repressed expression (p = 0.04) [1].'}]};
  const req=CORE.request(doc,['numeric-drift','citation-distortion','outcome-status-mislabeling','semantic-inversion'],8,'en');
  assert.match(req.instructions,/numeric-drift/);
  assert.match(req.instructions,/citation-distortion/);
  assert.match(req.instructions,/outcome-status-mislabeling/);
  assert.match(req.instructions,/semantic-inversion/);
  assert.match(req.instructions,/H3K27me3 vs H3K4me3/);
  assert.match(req.instructions,/in English/);
  assert.match(req.instructions,/never translate exact source/);

  const cand={
    id:'c1',segmentId:'s0',attackTypes:['semantic-inversion'],
    before:'Marker H3K27me3 repressed expression',after:'Marker H3K4me3 activated expression',
    rationale:'Inverts chromatin mark polarity.',
    evidence:[{segmentId:'s0',quote:'(p = 0.04) [1]',relation:'Context anchor.'}],
  };
  const validated=CORE.validateResponse(doc,{schema:CORE.VERSION,revision:'r1',sourceHash:'h1',status:'ok',candidates:[cand]});
  validated[0].selected=true;
  const patches=CORE.patches(doc,validated);
  assert.deepEqual(Object.keys(patches[0]).sort(),PATCH_KEYS.slice().sort());

  // Standalone VM without require or FalsifyAdversarialTaxonomy
  const vmCtx=vm.createContext({crypto:globalThis.crypto});
  vm.runInContext(CORE_SRC,vmCtx);
  assert.equal(vmCtx.FalsifyDocumentRed.TYPES.length,7);
  assert.equal(vmCtx.FalsifyDocumentRed.scanBlindnessLeaks('5 intentional errors').clean,false);
});

test('document-red enriches plan(), keeps finalState/PATCH_KEYS clean, and blocks blindness leaks before download',async()=>{
  const w=mountDocumentRed();
  const source='Marker H3K27me3 repressed expression in cohort A (p = 0.04).';
  w.document.dispatchEvent(new CustomEvent('falsify:document',{
    detail:{
      file:{name:'paper.txt',type:'text/plain',arrayBuffer:async()=>new TextEncoder().encode(source).buffer},
      result:{text:source,format:'TXT',segments:[{label:'p1',text:source}]},
    },
  }));
  await flush();

  w.get('red-request').click();
  await flush();
  const req=JSON.parse(await w.downloads.pop().text());

  const res={
    schema:req.schema,revision:req.revision,sourceHash:req.sourceHash,status:'ok',
    candidates:[{
      id:'c1',segmentId:'s0',attackTypes:['semantic-inversion'],
      before:'Marker H3K27me3 repressed expression',
      after:'Marker H3K4me3 activated expression (5 intentional errors)',
      rationale:'Flips chromatin mark.',
      evidence:[{segmentId:'s0',quote:'cohort A (p = 0.04)',relation:'Original result.'}],
      uncertainty:null,
    }],
  };
  w.get('red-response').value=JSON.stringify(res);
  w.get('red-import-response').click();
  await flush();

  // renderCandidates shows warning on the candidate card
  const warn=w.created.find(e=>e.className&&e.className.includes('red-blindness-warning'));
  assert.ok(warn&&!warn.hidden&&warn.textContent.includes('맹검 누출 경고'));

  // Select candidate and click download -> blocked before export
  const box=w.created.find(e=>e.type==='checkbox');
  box.checked=true;
  box.dispatchEvent(new Event('change'));
  assert.equal(w.get('red-export-status').classList.contains('error'),true);
  assert.match(w.get('red-export-status').textContent,/맹검 누출 차단/);

  w.get('red-download').click();
  await flush();
  assert.equal(w.exportCalls.length,0);
  assert.equal(w.downloads.length,0);
  assert.equal(w.get('red-export-status').classList.contains('error'),true);
  assert.match(w.get('red-export-status').textContent,/다운로드 차단: 맹검 누출 차단/);

  // Plan export includes enriched candidateRationales & blindnessCheck while selected adheres to PATCH_KEYS
  w.get('red-plan').click();
  await flush();
  const plan=JSON.parse(await w.downloads.pop().text());
  assert.deepEqual(Object.keys(plan.selected[0]).sort(),PATCH_KEYS.slice().sort());
  assert.equal(plan.blindnessCheck.clean,false);
  assert.equal(plan.candidateRationales[0].defectFamily,'S1');
  assert.equal(plan.candidateRationales[0].oracleSource,'domain-mechanism-definition');
  assert.equal(plan.candidateRationales[0].surface,'prose');
  assert.deepEqual(plan.candidateRationales[0].attackTypes,['semantic-inversion']);

  // Fix leak in textarea -> download succeeds and plan blindnessCheck becomes clean
  const area=w.created.find(e=>e.id==='red-after-0');
  area.value='Marker H3K4me3 activated expression';
  area.dispatchEvent(new Event('input'));
  assert.equal(warn.hidden,true);

  w.get('red-download').click();
  await flush();
  assert.equal(w.exportCalls.length,1);
  assert.equal(w.downloads.length,1);
  w.get('red-plan').click();
  await flush();
  const cleanPlan=JSON.parse(await w.downloads.pop().text());
  assert.equal(cleanPlan.blindnessCheck.clean,true);
  assert.deepEqual(cleanPlan.blindnessCheck.issues,[]);
});
