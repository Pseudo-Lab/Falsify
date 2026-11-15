'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const Sensor=require('../dist/blue-defect-sensor-core.js');
const Exchange=require('../dist/external-exchange.js');
const Proposals=require('../dist/external-proposals.js');

const HASH='a'.repeat(64);

test('D1 detects stat/percentage/CI mismatches while honoring 2-decimal p tolerance and statcheck adjusted-p guard',()=>{
  const pad=' word'.repeat(45);
  const segs=[
    {id:'s0',pageIndex:0,text:'Effect was z = 2.00, p = 0.05 (ok within 0.01 rounding).'},
    {id:'s1',pageIndex:1,text:'False claim z = 1.20, p = 0.01 and t(28) = 1.10, p = 0.02 and chi2(1) = 0.50, p = 0.01.'},
    {id:'s2',pageIndex:2,text:'Bonferroni-adjusted p: z = 3.50, p = 0.015 (raw p is smaller, must be exempt).'},
    {id:'s3',pageIndex:3,text:'Benjamini FDR adjusted p = 0.001 for z = 1.00, p = 0.001 (adjusted p smaller than raw p, still flagged).'},
    {id:'s4',pageIndex:4,text:'FDR mentioned far away.'+pad+' Unprotected z = 3.50, p = 0.04.'},
    {id:'s5',pageIndex:5,text:'Counts: 10/40 (25.0%) ok, 10/40 (35.0%) bad. OR = 1.80 (95% CI 1.10-1.50) outside; RR = 2.0 (95% CI 2.5-1.5) inverted.'}
  ];
  const r=Sensor.scanSegments({fileHash:HASH,segments:segs});
  assert.equal(r.schema,'falsify.blue-defect-sensor.v1');
  const statFails=r.signals.filter(s=>s.kind==='stat_pvalue_mismatch');
  assert.equal(statFails.length,5);
  assert.equal(statFails.some(s=>s.pageIndex===0),false);
  assert.equal(statFails.some(s=>s.pageIndex===2),false);
  assert.equal(statFails.some(s=>s.pageIndex===3),true);
  assert.equal(statFails.some(s=>s.pageIndex===4),true);
  const pctFails=r.signals.filter(s=>s.kind==='percentage_mismatch');
  assert.equal(pctFails.length,1);
  assert.match(pctFails[0].detail,/25\.00%.*35\.0%/);
  const ciFails=r.signals.filter(s=>s.kind==='ci_bounds_mismatch');
  assert.equal(ciFails.length,2);
});

test('D2 detects duplicate reference entries, duplicate DOIs, malformed DOIs, and out-of-range citations',()=>{
  const segs=[
    {id:'s0',pageIndex:0,text:'Body cites [1], [2], [9] and [2024].'},
    {id:'s1',pageIndex:1,text:[
      'References',
      '[1] Alpha Author. Study One on Biomarkers. Journal A 2020. doi:10.1038/nature12373',
      '[2] Alpha Author. Study One on Biomarkers. Journal A 2020. doi:10.1038/nature12373',
      '[3] Beta Author. Distinct Title Number Three. Journal B 2021. doi:10.1000/shared-doi',
      '[4] Gamma Author. Distinct Title Number Four. Journal C 2022. https://doi.org/10.1000/shared-doi',
      '[5] Delta Author. Broken DOI Reference Here. Journal D 2023. doi:10.123/broken'
    ].join('\n')}
  ];
  const r=Sensor.scanSegments({fileHash:HASH,segments:segs});
  const kinds=r.signals.map(s=>s.kind);
  assert.ok(kinds.includes('duplicate_reference_entry'));
  assert.ok(kinds.includes('duplicate_reference_uri_or_doi'));
  assert.ok(kinds.includes('malformed_doi'));
  const oor=r.signals.filter(s=>s.kind==='citation_index_out_of_range');
  assert.equal(oor.length,1);
  assert.equal(oor[0].reported.citedIndex,9);
});

test('mergeCompanionSensor and formatEvidencePackBlock enforce blindness and P0/P2 gating',()=>{
  const browser=Sensor.scanSegments({fileHash:HASH,segments:[{id:'s0',pageIndex:0,text:'10/40 (35.0%)'}]});
  const companion={
    schema:Sensor.SCHEMA,fileHash:HASH,tier:'P2',
    signals:[
      {category:'D2',kind:'uri_visible_doi_mismatch',pageIndex:5,detail:'Visible DOI differs from /URI target',excerpt:'10.1000/a'},
      {category:'D1',kind:'acroform_blank_fields',pageIndex:2,detail:'2 blank AcroForm fields',excerpt:'Field'}
    ],
    uriLinks:{total:5,mismatchCount:1},
    acroForm:{total:4,filled:2,blank:2},
    oraclePack:{summary:'1 Crossref mismatch',entries:[{provider:'Crossref',refIndex:30,detail:'Title mismatch (check PDF)'}]}
  };
  assert.throws(()=>Sensor.mergeCompanionSensor(browser,{...companion,fileHash:'b'.repeat(64)}));
  const merged=Sensor.mergeCompanionSensor(browser,companion);
  assert.equal(merged.signals.length,3);
  assert.equal(merged.uriLinks.mismatchCount,1);
  assert.equal(merged.acroForm.blank,2);
  const p0=Sensor.formatEvidencePackBlock(merged,{tier:'P0'});
  assert.doesNotMatch(p0,/Crossref/);
  assert.match(p0,/P0/);
  const p2=Sensor.formatEvidencePackBlock(merged,{tier:'P2'});
  assert.match(p2,/Crossref/);
  assert.match(p2,/검증 단서/);
  assert.throws(()=>Sensor.formatEvidencePackBlock({...merged,leaked:{before:'x'}}));
  assert.throws(()=>Sensor.formatEvidencePackBlock({...merged,oraclePack:{entries:[{gold:true}]}}));
});

test('reconcileCandidateLedger prevents silent W6 self-drop and requires rationale for resolvedOk',()=>{
  const ledger=[
    {candidateId:'C-1',page:3,locationLabel:'Table 1',defectFamily:'D1',quote:'10/40 (35.0%) reported in arm A',suspicion:'percentage mismatch'},
    {candidateId:'C-2',page:7,locationLabel:'References [30]',defectFamily:'D2',quote:'[30] Missing or mismatched reference entry',suspicion:'ref 30 mismatch'},
    {candidateId:'C-3',page:4,locationLabel:'Results',defectFamily:'D1',quote:'Bonferroni-adjusted p = 0.015 reported',suspicion:'statcheck check'},
    {candidateId:'C-4',page:5,locationLabel:'Discussion',defectFamily:'D3',quote:'Subgroup effect claimed overall',suspicion:'scope overclaim'}
  ];
  const findings=[
    {reportNumber:'F-1',candidateId:'C-1',page:3,locationLabel:'Table 1',findingType:'D1',verdictLabel:'아님',severity:'불일치',quote:'10/40 (35.0%) reported in arm A',rationale:'10/40=25% not 35%'},
    {reportNumber:'F-2',page:4,locationLabel:'Results',findingType:'D1',verdictLabel:'맞음',quote:'Bonferroni-adjusted p = 0.015 reported',rationale:'Multiplicity adjustment explicitly stated'},
    {reportNumber:'F-3',candidateId:'C-4',page:5,locationLabel:'Discussion',findingType:'D3',verdictLabel:'맞음',quote:'Subgroup effect claimed overall',rationale:''}
  ];
  const rec=Sensor.reconcileCandidateLedger(ledger,findings);
  assert.deepEqual(rec.summary,{stage1Count:4,resolvedOkCount:1,reportedDefectCount:1,recoveredCount:2});
  assert.equal(rec.findings.length,3);
  const recovered=rec.findings.filter(f=>f.zeroDropRecovered);
  assert.equal(recovered.length,2);
  assert.equal(recovered[0].reportNumber,'C-2');
  assert.equal(recovered[0].verdictLabel,'확인필요');
  assert.equal(recovered[1].reportNumber,'C-4');
});

test('external-exchange, proposals, and external-blue-ui integrate 2-stage Zero-Drop in JSON and Markdown',()=>{
  const segments=[
    {id:'s0',pageIndex:0,text:'10/40 (35.0%) reported.'},
    {id:'s1',pageIndex:1,text:'[30] Suspect reference 30 text here.'}
  ];
  const jsonRaw=JSON.stringify({
    fileHash:HASH,
    candidateLedger:[
      {candidateId:'C-1',page:1,locationLabel:'Results',defectFamily:'D1',quote:'10/40 (35.0%) reported.',suspicion:'pct wrong'},
      {candidateId:'C-2',page:2,locationLabel:'Ref 30',defectFamily:'D2',quote:'[30] Suspect reference 30 text here.',suspicion:'ref 30 dropped'}
    ],
    findings:[
      {reportNumber:'1',candidateId:'C-1',page:1,locationLabel:'Results',findingType:'D1',verdictLabel:'아님',severity:'불일치',quote:'10/40 (35.0%) reported.',rationale:'25% vs 35%',confidence:'높음'}
    ]
  });
  const jsonBatch=Exchange.parse(jsonRaw,{role:'blue',fileHash:HASH,segments});
  assert.deepEqual(jsonBatch.zeroDropSummary,{stage1Count:2,resolvedOkCount:0,reportedDefectCount:1,recoveredCount:1});
  assert.equal(jsonBatch.diagnostics[0].code,'zero-drop-recovered');
  assert.equal(jsonBatch.items.length,2);
  assert.equal(jsonBatch.items[1].zeroDropRecovered,true);
  assert.equal(jsonBatch.items[1].verdictLabel,'확인필요');

  const mdRaw=[
    '| 후보ID | 쪽 | 위치 | 유형 | 인용한 원문 | 의심 내용 |',
    '|---|---|---|---|---|---|',
    '| C-1 | 1 | Results | D1 | 10/40 (35.0%) reported. | pct wrong |',
    '| C-2 | 2 | Ref 30 | D2 | [30] Suspect reference 30 text here. | ref 30 dropped |',
    '',
    '| 번호 | 쪽 | 위치(절, 그림, 표) | 유형 | 심각도 | 판정 | 인용한 원문 | 왜 결함인가 | 확신 |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 1 | Results | D1 | 불일치 | 아님 | 10/40 (35.0%) reported. | 25% vs 35% | 높음 |',
    '',
    '## 보고서',
    '검토 완료'
  ].join('\n');
  const mdBatch=Exchange.parse(mdRaw,{role:'blue',fileHash:HASH,segments});
  assert.equal(mdBatch.items.length,2);
  assert.equal(mdBatch.items[1].zeroDropRecovered,true);
  assert.equal(mdBatch.report,'## 보고서\n검토 완료');

  const store=Proposals.create({fileHash:HASH,role:'blue',segments});
  store.append(jsonBatch);
  store.update('p1',{verdictLabel:'확인필요',defectFamily:'D2'});
  assert.equal(store.snapshot().items[0].verdictLabel,'확인필요');

  const all=[];
  function el(tag){const e=new EventTarget();Object.assign(e,{tagName:tag.toUpperCase(),children:[],textContent:'',value:'',files:[],checked:false,disabled:false,selectionStart:0,selectionEnd:0,append(...a){this.children.push(...a);},prepend(...a){this.children.unshift(...a);},replaceChildren(...a){this.children=a;},setAttribute(k,v){this[k]=String(v);},select(){},click(){this.dispatchEvent(new Event('click'));}});return e;}
  const host=el('section');host.id='document-blue';
  const doc=new EventTarget();Object.assign(doc,{createElement:el,querySelectorAll:()=>[],getElementById:id=>id==='document-blue'?host:all.find(e=>e.id===id)||null});
  const ctx={document:doc,FalsifyExternalExchange:Exchange,FalsifyBlueDefectSensor:Sensor,FalsifyDocumentBlueExternal:{getSource:()=>({fileHash:HASH,segments}),getExternalResponses:()=>store.snapshot(),acceptExternalResponse:b=>store.append(b)},confirm:()=>true};
  ctx.globalThis=ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/external-blue-ui.js'),'utf8'),ctx);
  const text=JSON.stringify(host);
  assert.match(text,/검증 누락 감사: 1단계 의심 2건 · 해소 0건 · 보고 1건 · Zero-Drop 자동 복원 1건/);
  assert.match(text,/판정: 확인필요 · Zero-Drop 누락 복원/);
});

test('prompt-instructions presets, undo, and P0/P2 evidence pack attachment work without leaking RED keys',()=>{
  const nodes=[];
  function el(tag){const n=new EventTarget();Object.assign(n,{tagName:tag.toUpperCase(),children:[],textContent:'',value:'',checked:false,disabled:false,hidden:false,append(...a){this.children.push(...a);},prepend(...a){this.children.unshift(...a);},replaceChildren(...a){this.children=a;},setAttribute(k,v){this[k]=String(v);},select(){},click(){this.dispatchEvent(new Event('click'));}});nodes.push(n);return n;}
  const doc=new EventTarget();doc.createElement=el;
  const ctx={document:doc,localStorage:{getItem:()=>null,setItem:()=>{}},FalsifyBlueDefectSensor:Sensor,navigator:{clipboard:{writeText:async()=>{}}}};
  ctx.globalThis=ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/prompt-instructions.js'),'utf8'),ctx);
  const status=el('p');
  const source={fileHash:HASH,name:'paper.pdf',segments:[{id:'s0',pageIndex:0,text:'10/40 (35.0%) reported.'}]};
  const report=Sensor.scanSegments(source);
  const merged=Sensor.mergeCompanionSensor(report,{schema:Sensor.SCHEMA,fileHash:HASH,tier:'P2',signals:[],oraclePack:{entries:[{provider:'Crossref',refIndex:30,detail:'Mismatch'}]}});
  Sensor.setActiveReport(HASH,merged);

  const ui=ctx.FalsifyPromptInstructions.mount(doc,'blue',()=>source,status);
  ui.prompt.value='custom draft';
  const presetSel=nodes.find(n=>n['aria-label']==='전술 프리셋');
  presetSel.value='blue-p2-oracle-2stage';
  nodes.find(n=>n.tagName==='BUTTON'&&n.textContent==='프리셋 적용').click();
  assert.match(ui.prompt.value,/candidateLedger/);
  assert.match(ui.prompt.value,/Crossref/);
  nodes.find(n=>n.tagName==='BUTTON'&&n.textContent==='불러오기 실행 취소').click();
  assert.equal(ui.prompt.value,'custom draft');

  const packBox=nodes.find(n=>n.tagName==='LABEL'&&n.textContent.includes('결정론적 센서')).children[0];
  const tierSel=nodes.find(n=>n['aria-label']==='BLUE 근거 범위');
  packBox.checked=true;
  tierSel.value='P0';
  const p0Text=ui.assembled();
  assert.match(p0Text,/percentage_mismatch/);
  assert.doesNotMatch(p0Text,/Crossref.*Mismatch/);
  tierSel.value='P2';
  const p2Text=ui.assembled();
  assert.match(p2Text,/Crossref/);
  Sensor.setActiveReport(HASH,null);
});

test('blue-defect-sensor-ui mounts after step 1, auto-scans P0, and runs Companion P0/P2 queries',async()=>{
  const nodes=[];
  function el(tag){
    const n=new EventTarget();
    Object.assign(n,{
      tagName:tag.toUpperCase(),children:[],textContent:'',value:'',checked:false,disabled:false,hidden:false,
      append(...a){this.children.push(...a);},prepend(...a){this.children.unshift(...a);},replaceChildren(...a){this.children=a;},
      setAttribute(k,v){this[k]=String(v);},
      after(x){const i=host.children.indexOf(this);if(i>=0)host.children.splice(i+1,0,x);else host.children.push(x);},
      click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
    });
    Object.defineProperty(n,'innerHTML',{set(){throw Error('unsafe innerHTML');}});
    nodes.push(n);return n;
  }
  const host=el('section');host.id='document-blue';
  const step1=el('section');step1.className='role-step';
  const step2=el('section');step2.className='role-step';
  host.append(step1,step2);
  const allNodes=n=>[n,...n.children.flatMap(allNodes)];
  const doc=new EventTarget();
  Object.assign(doc,{
    createElement:el,
    getElementById:id=>allNodes(host).find(n=>n.id===id)||null,
    querySelectorAll:sel=>sel==='.role-step'?host.children.filter(c=>String(c.className).includes('role-step')):[]
  });
  let connected=false;const calls=[];
  const source={fileHash:HASH,sourceHash:'s1',name:'study.pdf',format:'PDF',segments:[{id:'s0',pageIndex:0,text:'10/40 (35.0%)'}]};
  const pdfBytes=new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x37]);
  const pdfFile={name:'study.pdf',type:'application/pdf',size:pdfBytes.length,arrayBuffer:async()=>pdfBytes.buffer};
  const ctx={
    document:doc,btoa:s=>Buffer.from(s,'binary').toString('base64'),
    FalsifyBlueDefectSensor:Sensor,
    FalsifyDocumentBlueExternal:{getSource:()=>source,getPdfFile:()=>pdfFile},
    FalsifyLocalBridge:{
      state:()=>({connected}),
      session:()=>connected?{request:async(p,body)=>{calls.push({p,body});if(p.endsWith('/prepare'))return {paperId:'pid-1'};return {schema:Sensor.SCHEMA,fileHash:HASH,tier:body.includeExternalOracle?'P2':'P0',signals:[{category:'D2',kind:'uri_visible_doi_mismatch',pageIndex:0,detail:'URI mismatch',excerpt:'10.1/x'}],uriLinks:{total:3,mismatchCount:1},acroForm:{total:2,filled:1,blank:1},oraclePack:body.includeExternalOracle?{entries:[{provider:'Crossref',refIndex:1,detail:'ok'}]}:undefined};}}:null
    }
  };
  ctx.globalThis=ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/blue-defect-sensor-ui.js'),'utf8'),ctx);
  assert.equal(host.children[1].id,'blue-defect-sensor');
  const deepBtn=nodes.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('PDF 심층 포렌식'));
  const oracleBtn=nodes.find(n=>n.tagName==='BUTTON'&&n.textContent.includes('외부 오라클'));
  assert.equal(deepBtn.disabled,true);
  assert.equal(oracleBtn.disabled,true);
  connected=true;
  doc.dispatchEvent(new Event('falsify:local-bridge'));
  assert.equal(deepBtn.disabled,false);
  oracleBtn.click();
  await new Promise(r=>setImmediate(r));
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,2);
  assert.equal(calls[1].body.operation,'blue_sensor');
  assert.equal(calls[1].body.includeExternalOracle,true);
  const panelText=allNodes(host.children[1]).map(n=>n.textContent).join(' ');
  assert.match(panelText,/AcroForm 필드: 전체 2개 · 입력됨 1개 · 빈칸 1개/);
  assert.match(panelText,/DOI 불일치 1건/);
  Sensor.setActiveReport(HASH,null);
});

test('owned files pass complexity <= 15, safe DOM, and forbidden legacy substring checks',async()=>{
  const {javascriptFunctions}=await import('../../tools/quality/complexity.mjs');
  const legacy=['load-sample','FalsifyCore','SAMPLE_PROFILES','generateRed','runBlue','connectAgent','exportDemo','connectorTimers','legacy-review','blue-mode','blue-outcome','activity-log','doc-blue-comparison'];
  const ownedJs=['app/dist/blue-defect-sensor-core.js','app/dist/blue-defect-sensor-ui.js','app/dist/prompt-instructions.js','app/dist/external-exchange.js','app/dist/external-proposals.js','app/dist/external-blue-ui.js'];
  for(const rel of [...ownedJs,'app/dist/blue-defect-sensor.css']){
    const text=fs.readFileSync(path.resolve(__dirname,'../..',rel),'utf8');
    for(const bad of legacy)assert.equal(text.includes(bad),false,rel+' contains forbidden legacy substring '+bad);
    if(rel.endsWith('.js')){
      assert.doesNotMatch(text,/innerHTML|insertAdjacentHTML|outerHTML/);
      const fns=javascriptFunctions(text);
      for(const fn of fns)assert.ok(fn.ccn<=15,rel+':'+fn.id+' CCN='+fn.ccn+' exceeds 15');
    }
  }
});
