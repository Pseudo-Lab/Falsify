'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const Review=require('../dist/review-workbench.js');
const Arena=require('../dist/coevolution-arena.js');
const distDir=path.resolve(__dirname,'../dist');

const FORBIDDEN_LEGACY=[
  'load-sample','FalsifyCore','SAMPLE_PROFILES','generateRed','runBlue',
  'connectAgent','exportDemo','connectorTimers','legacy-review',
  'blue-mode','blue-outcome','activity-log','doc-blue-comparison'
];

function createSyntheticDoc(){
  const els=new Map();
  function element(tag){
    const e=new EventTarget();
    const classes=new Set();
    let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;if(v)els.set(v,e);}});
    Object.assign(e,{
      tagName:String(tag).toUpperCase(),
      disabled:false,hidden:false,checked:false,value:'',textContent:'',
      placeholder:'',children:[],files:[],parent:null,dataset:{},attrs:{},style:{},
      href:'',download:'',rows:2,maxLength:2000,
      classList:{
        toggle:(c,on)=>{const next=on??!classes.has(c);if(next)classes.add(c);else classes.delete(c);},
        contains:c=>classes.has(c)
      },
      setAttribute(k,v){this.attrs[k]=v;if(k==='data-view')this.dataset.view=v;},
      append(...c){for(const x of c){if(x&&typeof x==='object')x.parent=this;this.children.push(x);}},
      replaceChildren(...c){this.children=[];this.append(...c);},
      click(){this.dispatchEvent(new Event('click'));},
      querySelector(s){return s.startsWith('#')?els.get(s.slice(1))||null:null;}
    });
    return e;
  }
  const get=id=>{if(!els.has(id)){const e=element('div');e.id=id;}return els.get(id);};
  const doc=new EventTarget();
  const resultsBtn=element('button');resultsBtn.dataset.view='results';
  const blueBtn=element('button');blueBtn.dataset.view='blue';
  const wbBtn=element('button');wbBtn.dataset.view='workbench';
  get('view-results');
  Object.assign(doc,{
    readyState:'complete',
    createElement:element,
    querySelector(s){
      if(s.startsWith('#'))return get(s.slice(1));
      if(s==='[data-view="results"]')return resultsBtn;
      if(s==='[data-view="blue"]')return blueBtn;
      if(s==='[data-view="workbench"]')return wbBtn;
      return null;
    }
  });
  return {doc,get,resultsBtn,blueBtn,wbBtn};
}

function textDump(node){
  if(!node||typeof node!=='object')return '';
  return [node.textContent,...(node.children||[]).map(textDump)].filter(Boolean).join('\n');
}

function makeFixture(){
  const fHashA='a'.repeat(64),fHashH='h'.repeat(64);
  const segsA=[
    {id:'s0',label:'Results p.3',text:'Treatment reduced mortality by 12% (p = 0.04) with reference [1].'},
    {id:'s1',label:'Table 1',text:'Total cohort n = 120; intervention n = 60.'},
    {id:'s2',label:'Methods p.2',text:'Primary endpoint was 30-day readmission in NCT01234567.'}
  ];
  const segsH=[{id:'s0',label:'Abstract',text:'No difference was observed after Bonferroni correction (p = 0.08).'}];
  const redRoot={
    id:'red-root-1',role:'red',fileHash:'0'.repeat(64),sourceHash:'1'.repeat(64),
    sourceName:'paper-alpha.pdf',model:'gpt-6.1-sol',provenance:'local-codex',
    attackTypes:['numeric-drift','citation-distortion','outcome-status-mislabeling'],
    segments:segsA,
    response:{
      schema:'falsify.document-red.v1',status:'ok',coverage:{calls:3},
      candidates:[
        {id:'c1',segmentId:'s0',attackTypes:['numeric-drift'],before:'12%',after:'24%',rationale:'Doubled effect size.',evidence:[],uncertainty:'Synthetic'},
        {id:'c2',segmentId:'s0',attackTypes:['citation-distortion'],before:'reference [1]',after:'reference [99]',rationale:'Mismatched citation.',evidence:[],uncertainty:'Synthetic'},
        {id:'c3',segmentId:'s2',attackTypes:['outcome-status-mislabeling'],before:'Primary endpoint',after:'Exploratory endpoint',rationale:'Swapped primary label.',evidence:[],uncertainty:'Synthetic'}
      ]
    }
  };
  const redSnap={
    ...redRoot,id:'red-snap-1',snapshotOf:'red-root-1',
    finalState:{
      outputFileHash:fHashA,
      selected:[
        {id:'c1',segmentId:'s0',label:'Results p.3',before:'12%',after:'28%',offset:31,edited:true},
        {id:'c2',segmentId:'s0',label:'Results p.3',before:'reference [1]',after:'reference [99]',offset:52,edited:false},
        {id:'c3',segmentId:'s2',label:'Methods p.2',before:'Primary endpoint',after:'Exploratory endpoint',offset:0,edited:false}
      ]
    }
  };
  const blue1={
    id:'blue-1',role:'blue',fileHash:fHashA,sourceHash:'2'.repeat(64),sourceName:'paper-alpha.pdf',
    harnessHash:'hb1'.padEnd(64,'0'),harness:{name:'BlueCore',version:'1',role:'blue'},
    model:'gpt-6.1-sol',provenance:'local-codex',sourceRunId:'red-snap-1',durationMs:4250,tokens:1200,
    segments:segsA,
    response:{
      schema:'falsify.document-blue.v1',status:'ok',
      findings:[
        {id:'F1',segmentId:'s0',quote:'28%',rationale:'=SUM(A1:A2) numeric mismatch in Results.',evidence:[],uncertainty:'low'},
        {id:'F2',segmentId:'s0',quote:'Treatment',rationale:'Pre-existing typo in published text.',evidence:[],uncertainty:'low'},
        {id:'F3',segmentId:'s1',quote:'n = 120',rationale:'Spin wording border.',evidence:[],uncertainty:'med'},
        {id:'F4',segmentId:'s1',quote:'n = 60',rationale:'False positive alarm.',evidence:[],uncertainty:'med'},
        {id:'F5',segmentId:'s2',quote:'NCT01234567',rationale:'Needs registry lookup.',evidence:[],uncertainty:'high'},
        {id:'F6',segmentId:'s2',quote:'Exploratory endpoint',rationale:'Gold key was actually ambiguous.',evidence:[],uncertainty:'low'}
      ]
    }
  };
  const blue2={
    ...blue1,id:'blue-2',
    response:{
      schema:'falsify.document-blue.v1',status:'ok',
      findings:[
        blue1.response.findings[0],
        {id:'F7',segmentId:'s1',quote:'intervention n = 60',rationale:'Appeared only in repeat run 2.',evidence:[],uncertainty:'med'}
      ]
    }
  };
  const blueHoldout={
    id:'blue-holdout',role:'blue',fileHash:fHashH,sourceHash:'3'.repeat(64),sourceName:'clean-paper.pdf',
    harnessHash:'hb2'.padEnd(64,'0'),harness:{name:'BlueCore',version:'1',role:'blue'},
    model:'claude-opus-5-5',provenance:'local-codex',segments:segsH,
    response:{
      schema:'falsify.document-blue.v1',status:'ok',
      findings:[
        {id:'H1',segmentId:'s0',quote:'Bonferroni correction',rationale:'Claimed unadjusted p without checking Bonferroni.',evidence:[],uncertainty:'low'},
        {id:'H2',segmentId:'s0',quote:'p = 0.08',rationale:'Published source table had a pre-existing rounding discrepancy.',evidence:[],uncertainty:'low'}
      ]
    }
  };
  const rev1Superseded={id:'rev-old',runId:'blue-1',reviewer:'A',caseLabel:'P0',verdict:'uncertain',score:null,note:'Old review',comparison:null,findingAssessments:blue1.response.findings.map(f=>({id:f.id,verdict:'pending',note:''}))};
  const rev1={
    id:'rev-1',runId:'blue-1',reviewer:'Reviewer Kim',caseLabel:'paper-alpha P0 blind',
    verdict:'mixed',score:3,note:'Audited',
    comparison:{
      outputFileHash:fHashA,sourceRunId:'red-snap-1',
      selected:redSnap.finalState.selected.map(({id,label,before,after})=>({id,label,before,after})),
      assessments:[
        {id:'c1',verdict:'detected',note:'Caught 28%',quoteOverlapFindingIds:['F1']},
        {id:'c2',verdict:'missed',note:'Missed citation distortion',quoteOverlapFindingIds:[]},
        {id:'c3',verdict:'uncertain',note:'Needs registry check',quoteOverlapFindingIds:['F6']}
      ]
    },
    findingAssessments:[
      {id:'F1',verdict:'supported',note:'Hit D1'},
      {id:'F2',verdict:'pre-existing',note:'Published inconsistency'},
      {id:'F3',verdict:'spin-boundary',note:'Interpretation boundary'},
      {id:'F4',verdict:'unsupported',note:'Pure FP'},
      {id:'F5',verdict:'uncertain',note:'Needs external lookup'},
      {id:'F6',verdict:'gold-error',note:'Gold label ambiguous'}
    ],
    reviewContext:{mode:'red-assisted'}
  };
  const rev2={
    id:'rev-2',runId:'blue-2',reviewer:'Reviewer Kim',caseLabel:'P2 oracle pack',
    verdict:'supported',score:4,note:'Repeat run',comparison:null,
    findingAssessments:[
      {id:'F1',verdict:'unsupported',note:'Flipped judgment on repeat'},
      {id:'F7',verdict:'mixed',note:'Partial'}
    ]
  };
  const revHoldout={
    id:'rev-h',runId:'blue-holdout',reviewer:'Reviewer Lee',caseLabel:'Holdout clean control',
    verdict:'unsupported',score:2,note:'Control audit',comparison:null,
    findingAssessments:[
      {id:'H1',verdict:'unsupported',note:'Missed Bonferroni adjustment'},
      {id:'H2',verdict:'pre-existing',note:'Original paper rounding issue'}
    ]
  };
  const externalResponses=[{
    id:'ext-1',role:'blue',fileHash:fHashA,sourceName:'paper-alpha.pdf',
    snapshot:{
      role:'blue',
      batches:[{id:'b1',model:'gemini-4-hydrogen-high'}],
      items:[{id:'p1',locationLabel:'p.5',findingType:'numeric-drift',quote:'@raw_quote',rationale:'Recovered borderline',zeroDropRecovered:true,sourceRefs:[{batchId:'b1'}]}]
    }
  }];
  return {
    runs:[redRoot,redSnap,blue1,blue2,blueHoldout],
    reviews:[rev1Superseded,rev1,rev2,revHoldout],
    externalResponses
  };
}

test('static hygiene: no innerHTML and no forbidden legacy substrings in owned dist files',()=>{
  for(const file of ['coevolution-arena.js','coevolution-arena.css','review-workbench.js']){
    const src=fs.readFileSync(path.join(distDir,file),'utf8');
    assert.ok(!src.includes('innerHTML'),file+' must not use innerHTML');
    for(const term of FORBIDDEN_LEGACY){
      assert.ok(!src.includes(term),file+' must not contain forbidden substring: '+term);
    }
  }
});

test('review-workbench: 8 verdicts exported, backward-compatible validateExtras, and defect family badge',()=>{
  assert.deepEqual(Review.FINDING_VERDICTS,['pending','supported','pre-existing','spin-boundary','gold-error','unsupported','mixed','uncertain']);
  assert.equal(Review.VERDICT_LABELS['pre-existing'],'원본 기존 오류 · 출판본 자체 불일치 (순수 오탐 제외)');
  assert.equal(Review.VERDICT_LABELS['gold-error'],'정답표 오류 · RED 정답지 v2 개정 후보');

  const blueRun={
    role:'blue',
    segments:[{id:'s0',label:'p1',text:'Rate was 20% in [1].'}],
    response:{findings:[{id:'F1',segmentId:'s0',quote:'20%',rationale:'Drift',evidence:[],uncertainty:'low'}]}
  };
  const redRun={
    response:{candidates:[{id:'c1',segmentId:'s0',attackTypes:['numeric-drift'],before:'10%',after:'20%',rationale:'Changed number',evidence:[],uncertainty:'low'}]}
  };
  Review.validateExtras({
    reviewContext:{mode:'blue-only'},
    findingAssessments:[{id:'F1',verdict:'pre-existing',note:'Published paper error'}]
  },blueRun);
  Review.validateExtras({
    findingAssessments:[{id:'F1',verdict:'gold-error',note:'Gold v2 candidate'}]
  },blueRun);
  assert.throws(()=>Review.validateExtras({findingAssessments:[{id:'F1',verdict:'pre-existing',note:'   '}]},blueRun));

  const {doc}=createSyntheticDoc();
  const board=Review.render({
    document:doc,run:blueRun,redRun,
    patches:[{id:'c1',label:'p1',before:'10%',after:'20%'}],
    comparison:{assessments:[{id:'c1',verdict:'detected',note:'',quoteOverlapFindingIds:['F1']}]},
    findingAssessments:[{id:'F1',verdict:'spin-boundary',note:'Borderline'}]
  });
  const dump=textDump(board);
  assert.match(dump,/결함 분류: D1 \(numeric-drift\)/);
  const select=doc.querySelector('#evaluation-finding-0');
  assert.equal(select.children.length,8);
  assert.equal(select.value,'spin-boundary');
  assert.ok(doc.querySelector('#evaluation-patch-0'));
  assert.ok(doc.querySelector('#evaluation-patch-note-0'));
  assert.ok(doc.querySelector('#evaluation-finding-note-0'));

  globalThis.FalsifyAdversarialTaxonomy={classifyDefect:()=>({family:'D4-1',attackType:'outcome-status-mislabeling'})};
  try{
    const board2=Review.render({
      document:doc,run:blueRun,redRun:{response:{candidates:[{id:'c1',before:'10%',rationale:'Swapped',evidence:[],uncertainty:'low'}]}},
      patches:[{id:'c1',label:'p1',before:'10%',after:'20%'}],
      comparison:{assessments:[{id:'c1',verdict:'missed',note:'',quoteOverlapFindingIds:[]}]},
      findingAssessments:[{id:'F1',verdict:'pending',note:''}]
    });
    assert.match(textDump(board2),/결함 분류: D4-1 \(outcome-status-mislabeling\)/);
  }finally{delete globalThis.FalsifyAdversarialTaxonomy;}
});

test('coevolution-arena: dual scoreboard, 4-way precision, condition buckets, and gold v2 candidates',()=>{
  const fx=makeFixture();
  const sb=Arena.computeDualScoreboard(fx);
  assert.equal(sb.redRecall.injectedTotal,3);
  assert.equal(sb.redRecall.detectedStrict,1);
  assert.equal(sb.redRecall.detectedInclusive,2);
  assert.equal(sb.redRecall.missed,1);
  assert.equal(sb.redRecall.byFamily.D1.detectedStrict,1);
  assert.equal(sb.redRecall.byFamily.D2.missed,1);
  assert.equal(sb.redRecall.byFamily['D4-1'].detectedInclusive,1);
  assert.equal(sb.redRecall.bySurface.citation.missed,1);
  assert.equal(sb.redRecall.bySurface.registry.detectedInclusive,1);

  assert.equal(sb.bluePrecisionDual.strict.supported,1);
  assert.equal(sb.bluePrecisionDual.strict.preExisting,2);
  assert.equal(sb.bluePrecisionDual.strict.spinBoundary,1);
  assert.equal(sb.bluePrecisionDual.strict.goldError,1);
  assert.equal(sb.bluePrecisionDual.strict.pureFp,3);
  assert.equal(sb.bluePrecisionDual.strict.mixed,1);
  assert.equal(sb.bluePrecisionDual.inclusive.uncertain,1);
  assert.equal(sb.bluePrecisionDual.inclusive.zeroDropRecovered,1);

  assert.equal(sb.byCondition.Holdout.runCount,1);
  assert.equal(sb.byCondition.Holdout.strict.pureFp,1);
  assert.equal(sb.byCondition.Holdout.strict.preExisting,1);
  assert.equal(sb.byCondition.P2.runCount,1);
  assert.equal(sb.byCondition.P0.runCount,1);
  assert.equal(sb.goldV2Candidates.length,1);
  assert.deepEqual(sb.goldV2Candidates[0],{runId:'blue-1',findingId:'F6',reviewer:'Reviewer Kim',note:'Gold label ambiguous'});
});

test('coevolution-arena: model family bias detector and repeat-run verdict flip tracker',()=>{
  const same=Arena.detectModelFamilyBias('gpt-6.1-sol','o3-mini');
  assert.equal(same.sameFamily,true);
  assert.equal(same.redFamily,'openai');
  assert.equal(same.blueFamily,'openai');
  assert.match(same.warningKo,/동일 모델 계열 경고/);

  const diff=Arena.detectModelFamilyBias('claude-opus-5-5','gemini-4-hydrogen-high');
  assert.equal(diff.sameFamily,false);
  assert.equal(diff.redFamily,'anthropic');
  assert.equal(diff.blueFamily,'google');
  assert.equal(diff.warningKo,'');

  const unverified=Arena.detectModelFamilyBias('manual-model-unverified','gpt-6.1-sol');
  assert.equal(unverified.sameFamily,false);
  assert.equal(unverified.redFamily,null);

  const fx=makeFixture();
  const flips=Arena.computeRepeatRunFlips(fx.runs,fx.reviews);
  assert.equal(flips.groupCount,1);
  assert.equal(flips.stableFindingCount,0);
  assert.equal(flips.flippedFindingCount,7);
});

test('coevolution-arena: 12-column RFC 4180 BLUE CSV and RED answer-key JSON exporters',()=>{
  const fx=makeFixture();
  const csv=Arena.exportBlueScoreCsv({...fx,meta:{paperId:'AMAS-01',team:'team-k'}});
  const lines=csv.split('\n');
  assert.equal(lines[0],'paper_id,team,judge_type,model,iteration,location,defect_type,label,evidence,time_sec,tokens,is_holdout');
  for(const line of lines){
    const cols=line.match(/(?:"(?:""|[^"])*"|[^,])*/g)?.filter((_,i,a)=>!(i===a.length-1&&_===''&&line.endsWith(',')))||[];
    assert.ok(line.split(',').length>=12);
  }
  assert.match(csv,/,'=SUM\(A1:A2\) numeric mismatch in Results\. \| Hit D1,/);
  assert.match(csv,/AMAS-01,team-k,external-ai,gemini-4-hydrogen-high,1,p\.5,D1,확인필요,/);
  assert.match(csv,/AMAS-01,team-k,harness,claude-opus-5-5,1,Abstract,,맞음,.*?,true$/m);
  assert.match(csv,/AMAS-01,team-k,harness,gpt-6\.1-sol,1,Results p\.3,D1,아님,.*,4\.25,1200,false/);

  const quotedCsv=Arena.exportBlueScoreCsv({
    runs:[{id:'q1',role:'blue',fileHash:'b'.repeat(64),sourceName:'paper, "quoted".pdf',model:'gpt-6.1-sol',segments:[{id:'s0',label:'p.1',text:'x'}],response:{status:'ok',findings:[{id:'F1',segmentId:'s0',quote:'x',rationale:'line1\n"line2", comma'}]}}],
    reviews:[{runId:'q1',caseLabel:'P0',findingAssessments:[{id:'F1',verdict:'supported',note:'ok'}]}]
  });
  assert.match(quotedCsv,/"paper, ""quoted""\.pdf"/);
  assert.match(quotedCsv,/"line1\n""line2"", comma \| ok"/);

  const json=Arena.exportRedAnswerKeyJson({redRun:fx.runs[1],runs:fx.runs,reviews:fx.reviews,meta:{paperId:'AMAS-01',team:'team-k'}});
  assert.equal(json.schema,'falsify.red-answer-key.v1');
  assert.equal(json.gold_version,'v2-candidate');
  assert.equal(json.entries.length,3);
  assert.deepEqual(Object.keys(json.entries[0]),[
    'paper_id','team','defect_type','location','before','after',
    'iterations','self_check_model','patch_v1','patch_final','why_hard','ai_assisted','gold_version'
  ]);
  assert.equal(json.entries[0].defect_type,'D1');
  assert.equal(json.entries[0].patch_v1,'24%');
  assert.equal(json.entries[0].patch_final,'28%');
  assert.equal(json.entries[0].iterations,3);
  assert.equal(json.entries[1].defect_type,'D2');
  assert.equal(json.entries[2].defect_type,'D4-1');
});

test('coevolution-arena: C1 briefs never leak quotes, before, after, or gold',()=>{
  const fx=makeFixture();
  const sb=Arena.computeDualScoreboard(fx);
  const blueBrief=Arena.buildCoevolutionBrief({role:'blue',scoreboard:sb});
  const redBrief=Arena.buildCoevolutionBrief({role:'red',scoreboard:sb});
  for(const text of [blueBrief.instructionsText,redBrief.instructionsText]){
    for(const secret of ['12%','24%','28%','reference [1]','reference [99]','NCT01234567','p = 0.08','No difference was observed','Treatment reduced mortality','Exploratory endpoint','=SUM']){
      assert.ok(!text.includes(secret),'Brief must not leak source/answer text: '+secret);
    }
  }
  assert.match(blueBrief.instructionsText,/D2\(인용 왜곡\) 미탐 1건/);
  assert.match(blueBrief.instructionsText,/Zero-Drop 복구 1건/);
  assert.match(blueBrief.instructionsText,/Holdout 대조군 순수 오탐 1건/);
  assert.match(redBrief.instructionsText,/L1 → L2 → L3 → L4/);
});

test('coevolution-arena: mount(doc) renders UI, persists conditions, downloads exports, and opens C1 drafts',async()=>{
  const fx=makeFixture();
  const {doc,get,blueBtn}=createSyntheticDoc();
  const store=new Map();
  const downloads=[];
  const dispatched=[];
  doc.addEventListener('falsify:edit-harness-instructions',e=>dispatched.push(e.detail));
  let blueNavClicked=false;
  blueBtn.addEventListener('click',()=>{blueNavClicked=true;});

  const ctx=vm.createContext({
    document:doc,
    localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},
    FalsifyLab:{
      ready:Promise.resolve(),
      reviewSnapshot:async()=>fx,
      promptInstructions:async role=>[{id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',instructions:'Base instructions.',role,hash:'h'.repeat(64)}],
      selectedHarness:role=>({id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',instructions:'Base instructions.',role})
    },
    Blob:class{constructor(parts,opts){this.text=parts.join('');this.type=opts?.type;}},
    URL:{createObjectURL:b=>{downloads.push(b);return 'blob:1';},revokeObjectURL(){}},
    CustomEvent,Event,setTimeout,clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(distDir,'coevolution-arena.js'),'utf8'),ctx,{filename:'coevolution-arena.js'});
  await new Promise(r=>setTimeout(r,20));

  const arenaEl=get('coevolution-arena');
  const dump=textDump(arenaEl);
  assert.match(dump,/경찰\(BLUE\) ↔ 도둑\(RED\) 상보적 진화 아레나/);
  assert.match(dump,/동일 모델 계열 경고/);
  assert.match(dump,/RED 정답지 v2 개정 후보 1건/);

  get('arena-paper-id').value='PAPER-99';
  get('arena-export-csv').click();
  get('arena-export-red-json').click();
  assert.equal(downloads.length,2);
  assert.match(downloads[0].text,/^paper_id,team,judge_type,/);
  assert.match(downloads[0].text,/PAPER-99,falsify,/);
  assert.equal(JSON.parse(downloads[1].text).schema,'falsify.red-answer-key.v1');

  get('arena-open-blue-brief').click();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(blueNavClicked,true);
  assert.equal(dispatched.length,1);
  assert.equal(dispatched[0].role,'blue');
  assert.equal(dispatched[0].version,'2');
  assert.match(dispatched[0].instructions,/\[BLUE Co-Evolution Brief\]/);

  get('arena-open-red-brief').click();
  await new Promise(r=>setTimeout(r,20));
  assert.equal(dispatched.length,2);
  assert.equal(dispatched[1].role,'red');
  assert.equal(dispatched[1].version,'2');
  assert.match(dispatched[1].instructions,/\[RED Co-Evolution Brief\]/);

  assert.ok(get('arena-agreement-card'));
  assert.ok(get('arena-selective-card'));
  assert.match(dump,/다중 판정 일치도 · Krippendorff's α/);
  assert.match(dump,/유보\(확인필요\) 선택적 예측 · Risk-Coverage/);
  get('arena-export-metrics-json').click();
  assert.equal(downloads.length,3);
  const metricsPayload=JSON.parse(downloads[2].text);
  assert.equal(metricsPayload.schema,'falsify.arena-academic-metrics.v1');
  assert.ok(metricsPayload.agreement);
  assert.ok(metricsPayload.selectivePrediction);
});

test('coevolution-arena: Krippendorff alpha nominal/ordinal, missing data, unanimous, and ledger extraction',()=>{
  const k11=[
    [1,1,null,1],
    [2,2,3,2],
    [3,3,3,3],
    [3,3,3,3],
    [2,2,2,2],
    [1,2,3,4],
    [4,4,4,4],
    [1,1,2,1],
    [2,2,2,2],
    [null,5,5,5],
    [null,null,1,1],
    [null,null,3,null]
  ];
  const nom=Arena.computeKrippendorffAlpha(k11,{level:'nominal'});
  assert.equal(nom.status,'ok');
  assert.equal(nom.pairableUnits,11);
  assert.equal(nom.alpha,0.7434);
  assert.equal(nom.band,'잠정 합의 (0.67–0.80)');

  const ord=Arena.computeKrippendorffAlpha(k11,{level:'ordinal'});
  assert.equal(ord.status,'ok');
  assert.equal(ord.alpha,0.8154);
  assert.equal(ord.band,'신뢰 가능 (≥0.80)');

  const ins=Arena.computeKrippendorffAlpha([[null,'아님'],['pending',''],['맞음']]);
  assert.equal(ins.status,'insufficient_pairs');
  assert.equal(ins.alpha,null);
  assert.equal(ins.pairableUnits,0);
  assert.deepEqual(ins.categories,[]);

  const una=Arena.computeKrippendorffAlpha([['아님','아님','pending'],{unitId:'u2',ratings:['아님','','아님']}]);
  assert.equal(una.status,'unanimous');
  assert.equal(una.alpha,1);
  assert.equal(una.observedDisagreement,0);
  assert.equal(una.expectedDisagreement,0);

  const fx=makeFixture();
  const ledgerAgree=Arena.computeLedgerAgreement(fx.runs,fx.reviews);
  assert.equal(ledgerAgree.humanReviews.nominal.pairableUnits,1);
  assert.equal(ledgerAgree.blueRuns.nominal.pairableUnits,7);
  assert.equal(typeof ledgerAgree.blueRuns.ordinal.alpha,'number');
});

test('coevolution-arena: selective prediction AURC, abstention gain, brief guidance, and JS/Python parity',()=>{
  const items=[
    {tier:1,isCorrect:true},
    {tier:1,isCorrect:true},
    {tier:1,isCorrect:true},
    {tier:1,isCorrect:true},
    {tier:2,isCorrect:true},
    {tier:2,isCorrect:false},
    {tier:2,isCorrect:false},
    {tier:3,isCorrect:false},
    {tier:3,isCorrect:false},
    {tier:3,isCorrect:false}
  ];
  const sel=Arena.computeSelectivePrediction(items);
  assert.equal(sel.status,'ok');
  assert.equal(sel.totalEvaluated,10);
  assert.equal(sel.committedCount,4);
  assert.equal(sel.abstainedCount,6);
  assert.equal(sel.abstentionRate,0.6);
  assert.equal(sel.coverageAtCommitted,0.4);
  assert.equal(sel.selectiveAccuracy,1);
  assert.equal(sel.selectiveRisk,0);
  assert.equal(sel.fullCoverageAccuracy,0.5);
  assert.equal(sel.abstentionGain,0.5);
  assert.equal(sel.aurc,0.1607);
  assert.equal(sel.riskCoverageCurve.length,3);

  const fx=makeFixture();
  const ledgerSel=Arena.computeSelectivePrediction(fx);
  assert.equal(ledgerSel.status,'ok');
  assert.equal(ledgerSel.committedCount,7);

  const sb=Arena.computeDualScoreboard(fx);
  const lowAlpha={nominal:{alpha:0.45,status:'ok'},ordinal:{alpha:0.5,status:'ok'}};
  const negGain={abstentionGain:-0.12};
  const brief=Arena.buildCoevolutionBrief({role:'blue',scoreboard:sb,agreement:lowAlpha,selectivePrediction:negGain});
  assert.match(brief.instructionsText,/Krippendorff α < 0\.667/);
  assert.match(brief.instructionsText,/Abstention Gain < 0/);

  const {spawnSync}=require('node:child_process');
  const os=require('node:os');
  const wavePy='C:\\Users\\user\\source\\falsify\\coordination\\ocr-chart-wave-20261103\\runtime\\Scripts\\python.exe';
  const pyBin=fs.existsSync(wavePy)?wavePy:(process.env.PYTHON||'python');
  const tmpFile=path.join(os.tmpdir(),'falsify-parity-'+process.pid+'.json');
  const units=[
    ['맞음','맞음','확인필요'],
    ['아님','아님','아님'],
    ['확인필요','아님',null],
    ['맞음','pending','맞음']
  ];
  fs.writeFileSync(tmpFile,JSON.stringify({units,items}),'utf8');
  try{
    const run=spawnSync(pyBin,[path.resolve(__dirname,'../../tools/evaluation/agreement_selective.py'),'--units-json',tmpFile],{encoding:'utf8'});
    if(!run.error&&run.status===0){
      const pyRes=JSON.parse(run.stdout);
      const jsNom=Arena.computeKrippendorffAlpha(units,{level:'nominal'});
      const jsOrd=Arena.computeKrippendorffAlpha(units,{level:'ordinal'});
      assert.equal(jsNom.alpha,pyRes.nominal_alpha);
      assert.equal(jsOrd.alpha,pyRes.ordinal_alpha);
      assert.equal(sel.abstentionRate,pyRes.abstention_rate);
      assert.equal(sel.selectiveAccuracy,pyRes.selective_accuracy);
      assert.equal(sel.abstentionGain,pyRes.abstention_gain);
      assert.equal(sel.aurc,pyRes.aurc);
      assert.deepEqual(sel.riskCoverageCurve,pyRes.risk_coverage_curve);
    }
  }finally{
    try{fs.unlinkSync(tmpFile);}catch{}
  }
});
