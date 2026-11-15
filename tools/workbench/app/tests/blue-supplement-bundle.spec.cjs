'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const Bundle=require('../dist/blue-supplement-bundle.js');
const BlueCore=require('../dist/document-blue-core.js');

function makeNode(tag,ownerDoc){
  const el=new EventTarget();
  const classSet=new Set();
  const attrs=new Map();
  Object.assign(el,{
    tagName:String(tag).toUpperCase(),
    ownerDocument:ownerDoc,
    parentElement:null,
    children:[],
    textContent:'',
    value:'',
    checked:false,
    disabled:false,
    hidden:false,
    type:'',
    multiple:false,
    accept:'',
    files:[],
    style:{},
    classList:{
      add:(...c)=>c.forEach(x=>classSet.add(x)),
      remove:(...c)=>c.forEach(x=>classSet.delete(x)),
      contains:x=>classSet.has(x),
      toggle:(x,f)=>{if(f===undefined)f=!classSet.has(x);if(f)classSet.add(x);else classSet.delete(x);return f;}
    },
    append(...nodes){
      for(const n of nodes){
        if(n&&typeof n==='object'){n.parentElement=this;this.children.push(n);}
      }
    },
    prepend(...nodes){
      for(const n of [...nodes].reverse()){
        if(n&&typeof n==='object'){n.parentElement=this;this.children.unshift(n);}
      }
    },
    replaceChildren(...nodes){this.children=[];this.append(...nodes);},
    after(node){
      if(!this.parentElement)return;
      const idx=this.parentElement.children.indexOf(this);
      node.parentElement=this.parentElement;
      if(idx>=0)this.parentElement.children.splice(idx+1,0,node);
      else this.parentElement.children.push(node);
    },
    setAttribute(k,v){attrs.set(k,String(v));if(k==='id')this.id=String(v);},
    getAttribute(k){return attrs.get(k)??null;},
    closest(){return null;},
    querySelector(sel){return allDescendants(this).find(n=>matchesSimple(n,sel))||null;},
    querySelectorAll(sel){
      if(sel.startsWith(':scope > '))return this.children.filter(n=>matchesSimple(n,sel.slice(9)));
      return allDescendants(this).filter(n=>matchesSimple(n,sel));
    },
    click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  });
  Object.defineProperty(el,'className',{
    get(){return [...classSet].join(' ');},
    set(v){classSet.clear();String(v||'').split(/\s+/).filter(Boolean).forEach(x=>classSet.add(x));}
  });
  Object.defineProperty(el,'innerHTML',{set(){throw new Error('unsafe innerHTML');}});
  Object.defineProperty(el,'outerHTML',{set(){throw new Error('unsafe outerHTML');}});
  return el;
}

function allDescendants(node){
  const out=[];
  for(const c of node.children||[]){out.push(c);out.push(...allDescendants(c));}
  return out;
}

function matchesSimple(node,sel){
  if(!node||!sel)return false;
  if(sel.startsWith('#'))return node.id===sel.slice(1);
  if(sel.startsWith('.'))return node.classList.contains(sel.slice(1));
  return node.tagName===sel.toUpperCase();
}

function makeMockDoc(){
  const doc=new EventTarget();
  doc.createElement=tag=>makeNode(tag,doc);
  doc.createTextNode=text=>({nodeType:3,textContent:String(text)});
  doc.body=makeNode('body',doc);
  doc.getElementById=id=>allDescendants(doc.body).find(n=>n.id===id)||null;
  doc.querySelector=sel=>doc.body.querySelector(sel);
  doc.querySelectorAll=sel=>doc.body.querySelectorAll(sel);
  return doc;
}

test('auditMainVsSupplements detects W4 missing Table S4, N=120 vs 98 CSV/log, and Table S1 metric mismatch',()=>{
  const mainSegments=[
    {id:'s0',pageIndex:0,text:'We analyzed N = 120 patients across all sites (n = 60 treatment, n = 60 control).'},
    {id:'s1',pageIndex:1,text:'Baseline characteristics are in Table S1 (AUC = 0.94, p = 0.003), sensitivity in Fig. S2, and subgroup tests in Table S4.'},
    {id:'s2',pageIndex:2,text:'Final classifier accuracy = 94.2% on held-out evaluation.'}
  ];
  const csvRows=['patient_id,arm,outcome'];
  for(let i=1;i<=98;i++)csvRows.push('P'+i+','+(i%2?'A':'B')+',1');
  const supplements=[
    {fileId:'f1',name:'supplement.pdf',kind:'supplement-doc',segments:[
      {id:'s0',label:'PDF p. 1',text:'Table S1. Model summary: AUC = 0.81, p = 0.041.\nFigure S2. Sensitivity plot.'},
      {id:'s1',label:'PDF p. 2',text:'Table S3. Adverse events.'}
    ]},
    {fileId:'f2',name:'cohort_data.csv',kind:'table-data',segments:[{id:'s0',label:'CSV',text:csvRows.join('\n')}]},
    {fileId:'f3',name:'eval.log',kind:'code-or-log',segments:[{id:'s0',label:'LOG',text:'[INFO] Loaded 98 rows\naccuracy = 0.812'}]}
  ];

  const report=Bundle.auditMainVsSupplements({mainSegments,supplements});
  assert.equal(report.schema,'falsify.blue-supplement-bundle.v1');
  assert.equal(report.supplementCount,3);

  const missing=report.signals.filter(s=>s.kind==='missing_supplementary_item');
  assert.equal(missing.length,1);
  assert.equal(missing[0].family,'D4-1');
  assert.equal(missing[0].reported.item,'Table S4');

  const nMismatches=report.signals.filter(s=>s.kind==='cross_file_sample_size_mismatch');
  assert.ok(nMismatches.length>=1);
  assert.equal(nMismatches[0].family,'D1');
  assert.equal(nMismatches[0].reported.mainN,120);
  assert.equal(nMismatches[0].computed.supplementN,98);

  const mMismatches=report.signals.filter(s=>s.kind==='cross_file_metric_mismatch');
  const keys=mMismatches.map(s=>s.reported.metric).sort();
  assert.deepEqual(keys,['accuracy','auc','p']);
});

test('auditMainVsSupplements avoids false positives on matching Korean/English anchors, equivalent percent, and distinct cohorts',()=>{
  const mainSegments=[
    {id:'s0',pageIndex:0,text:'Discovery cohort (N = 200) and Validation cohort (N = 80). See 보충표 1, 보충그림 2, and Appendix B.'},
    {id:'s1',pageIndex:1,text:'In Supplementary Table 1, accuracy = 94.2% and AUC = 0.91.'}
  ];
  const supplements=[
    {fileId:'f1',name:'supplement.md',kind:'supplement-doc',segments:[
      {id:'s0',label:'MD 1',text:'Table S1: accuracy = 0.942, AUC = 0.91.\nFigure S2.\nAppendix B.'}
    ]},
    {fileId:'f2',name:'validation_cohort.csv',kind:'table-data',segments:[
      {id:'s0',label:'CSV',text:'Metric,Value\nAccuracy,0.942\nAUC,0.91'}
    ]}
  ];
  const report=Bundle.auditMainVsSupplements({mainSegments,supplements});
  assert.equal(report.counts.total,0);

  const emptySupp=Bundle.auditMainVsSupplements({mainSegments:[{id:'s0',text:'See Table S4.'}],supplements:[]});
  assert.equal(emptySupp.counts.total,0);
});

test('toSupplementalSegments formats IDs/labels and assertNoRedKeys enforces strict blindness',()=>{
  const segs=Bundle.toSupplementalSegments([
    {name:'eval.log',kind:'code-or-log',segments:[{id:'s0',label:'LOG 구간 1',text:'accuracy = 0.812'}]}
  ]);
  assert.deepEqual(segs,[{id:'supp-0-0',label:'[보충: eval.log · LOG 구간 1]',text:'accuracy = 0.812'}]);
  assert.throws(()=>Bundle.auditMainVsSupplements({mainSegments:[{id:'s0',text:'x',before:'leak'}],supplements:[]}));
  assert.throws(()=>Bundle.auditMainVsSupplements({mainSegments:[{id:'s0',text:'x'}],supplements:[{name:'a.txt',text:'y',candidateRationales:[]}]}));
});

test('mount mounts without .role-step, extracts .py/.log via UTF-8 fallback, and restores main segments on clear',async()=>{
  const doc=makeMockDoc();
  const host=doc.createElement('section');host.id='document-blue';
  const step1=doc.createElement('section');step1.className='role-step';
  const sensor=doc.createElement('section');sensor.id='blue-defect-sensor';
  const step2=doc.createElement('section');step2.className='role-step';
  const step3=doc.createElement('section');step3.className='role-step';
  host.append(step1,sensor,step2,step3);
  doc.body.append(host);

  const mainHash='m'.repeat(64);
  let activeDoc={
    fileHash:mainHash,
    sourceHash:'orig-source-hash',
    revision:'rev-1',
    name:'paper.pdf',
    segments:[
      {id:'s0',label:'PDF p. 1',text:'We analyzed N = 120 patients. Table S4 shows subgroups. Accuracy = 94.2%.'},
      {id:'ocr-page-1',label:'OCR · PDF p. 2',text:'OCR text preserved.'}
    ]
  };

  const pushed=[];
  const ctx={
    document:doc,
    crypto:crypto.webcrypto,
    TextEncoder,TextDecoder,Event,CustomEvent,
    FalsifyImport:{
      async extract(file){
        if(/\.(py|r|log|json)$/i.test(file.name))throw new Error('unsupported code ext');
        const txt=await file.text();
        return {format:'TXT',text:txt,segments:[{label:'구간 1',text:txt}],warnings:[]};
      }
    },
    FalsifyDocumentBlueExternal:{
      getSource:()=>activeDoc?{...activeDoc,segments:activeDoc.segments.map(s=>({...s}))}:null,
      async setSupplementalSegments(suppSegs,expectedHash){
        assert.equal(expectedHash,mainHash);
        const base=activeDoc.segments.filter(s=>!String(s.id).startsWith('supp-'));
        const next=[...base,...suppSegs.map((s,i)=>({id:'supp-'+i,label:s.label,text:s.text}))];
        activeDoc={...activeDoc,segments:next,sourceHash:'hash-'+next.length};
        pushed.push(suppSegs);
        doc.dispatchEvent(new CustomEvent('falsify:blue-state',{detail:{name:activeDoc.name}}));
      }
    }
  };
  ctx.globalThis=ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/blue-supplement-bundle.js'),'utf8'),ctx);

  const panel=doc.getElementById('blue-supplement-panel');
  assert.ok(panel,'#blue-supplement-panel mounted');
  assert.equal(panel.classList.contains('role-step'),false,'must never have .role-step');
  assert.equal(host.children.indexOf(panel),2,'mounted right after #blue-defect-sensor');
  assert.deepEqual(host.querySelectorAll(':scope > .role-step'),[step1,step2,step3]);

  const input=doc.getElementById('blue-supplement-files');
  assert.equal(input.disabled,false);

  const pyText='Table S1.\n# accuracy = 0.812\nn_samples = 98\n';
  const suppTxt='Table S1: baseline only.';
  const makeFile=(name,content)=>({
    name,size:Buffer.byteLength(content),
    text:async()=>content,
    arrayBuffer:async()=>Uint8Array.from(Buffer.from(content)).buffer
  });
  input.files=[makeFile('analysis.py',pyText),makeFile('supplement.txt',suppTxt)];
  input.dispatchEvent(new Event('change'));
  await new Promise(r=>setTimeout(r,30));

  assert.equal(pushed.length,1);
  assert.equal(pushed[0].length,2);
  assert.equal(activeDoc.segments.filter(s=>!s.id.startsWith('supp-')).length,2);
  assert.equal(activeDoc.segments.filter(s=>s.id.startsWith('supp-')).length,2);
  assert.match(panel.querySelector('.blue-supplement-summary').textContent,/보충자료 2개 연결됨/);
  assert.match(panel.querySelector('.blue-supplement-list').children.map(n=>n.querySelector('.blue-supplement-item-head').textContent).join(' '),/missing_supplementary_item/);

  doc.getElementById('blue-supplement-clear').click();
  await new Promise(r=>setTimeout(r,30));
  assert.equal(activeDoc.segments.length,2);
  assert.equal(activeDoc.segments[1].id,'ocr-page-1');
  assert.match(panel.querySelector('.blue-supplement-summary').textContent,/단일 파일 모드/);
});

test('document-blue.js FalsifyDocumentBlueExternal.setSupplementalSegments & getPdfFile preserve base/OCR and restore original sourceHash',async()=>{
  const doc=makeMockDoc();
  const ids=['doc-blue-file','doc-blue-summary','doc-blue-progress','doc-blue-start','doc-blue-request','doc-blue-apply','doc-blue-cancel','doc-blue-budget','doc-blue-record','doc-blue-findings','doc-blue-result-summary','doc-blue-record-status','doc-blue-response','doc-blue-consent','blue-harness-consent','doc-blue-clear','doc-blue-connection'];
  for(const id of ids){
    const tag=id==='doc-blue-budget'?'input':id==='doc-blue-consent'||id==='blue-harness-consent'?'input':id==='doc-blue-file'?'input':'div';
    const el=doc.createElement(tag);el.id=id;
    if(tag==='input'&&id.includes('consent'))el.type='checkbox';
    if(id==='doc-blue-budget')el.value='4';
    if(id==='doc-blue-consent'){const lbl=doc.createElement('label');lbl.append(el);el.closest=()=>lbl;doc.body.append(lbl);continue;}
    doc.body.append(el);
  }

  let resetEvents=0;
  doc.addEventListener('falsify:blue-supplement-reset',()=>{resetEvents++;});

  const sampleText='Main paper paragraph one.\n\nMain paper paragraph two.';
  const sampleBuf=Uint8Array.from(Buffer.from(sampleText)).buffer;
  const fakeFile={name:'paper.txt',size:sampleBuf.byteLength,arrayBuffer:async()=>sampleBuf};
  const ctx={
    document:doc,
    crypto:crypto.webcrypto,
    TextEncoder,TextDecoder,Event,CustomEvent,AbortController,URL,Blob,
    FalsifyDocumentBlue:BlueCore,
    FalsifyLocalBridge:{state:()=>({connected:false}),capabilities:()=>({blue:false}),session:()=>null,busy:()=>{}},
    FalsifyLab:{allowed:()=>true,busy:()=>{}},
    FalsifyImport:{extract:async()=>({format:'TXT',text:sampleText,segments:[{label:'문단 1',text:'Main paper paragraph one.'},{label:'문단 2',text:'Main paper paragraph two.'}],warnings:[]})}
  };
  ctx.globalThis=ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/document-blue.js'),'utf8'),ctx);

  const ext=ctx.FalsifyDocumentBlueExternal;
  assert.equal(ext.getPdfFile(),null);
  await assert.rejects(()=>ext.setSupplementalSegments([], 'bad'));

  const fileInput=doc.getElementById('doc-blue-file');
  fileInput.files=[fakeFile];
  fileInput.dispatchEvent(new Event('change'));
  await new Promise(r=>setTimeout(r,40));

  const initial=ext.getSource();
  assert.ok(initial);
  assert.equal(ext.getPdfFile(),fakeFile);
  const origSourceHash=initial.sourceHash;

  await assert.rejects(()=>ext.setSupplementalSegments([], 'wrong-hash'));
  await ext.setSupplementalSegments([
    {label:'[보충: s.txt · p1]',text:'Supplement text'},
    {label:'Empty skipped',text:'   '}
  ],initial.fileHash);

  const withSupp=ext.getSource();
  assert.equal(withSupp.segments.length,3);
  assert.equal(withSupp.segments[2].id,'supp-0');
  assert.notEqual(withSupp.sourceHash,origSourceHash);
  assert.match(doc.getElementById('doc-blue-summary').textContent,/보충자료 1개 구간 포함/);

  await ext.setSupplementalSegments([],initial.fileHash);
  const restored=ext.getSource();
  assert.equal(restored.segments.length,2);
  assert.equal(restored.sourceHash,origSourceHash);
  assert.doesNotMatch(doc.getElementById('doc-blue-summary').textContent,/보충자료/);

  doc.getElementById('doc-blue-clear').click();
  assert.ok(resetEvents>=1);
  assert.equal(ext.getPdfFile(),null);
});

test('owned JS and CSS files pass CCN <= 15, safe DOM, mobile viewport rules, and forbidden legacy substring checks',async()=>{
  const {javascriptFunctions}=await import('../../tools/quality/complexity.mjs');
  const legacy=['load-sample','FalsifyCore','SAMPLE_PROFILES','generateRed','runBlue','connectAgent','exportDemo','connectorTimers','legacy-review','blue-mode','blue-outcome','activity-log','doc-blue-comparison'];
  for(const rel of ['app/dist/blue-supplement-bundle.js','app/dist/document-blue.js','app/dist/blue-supplement-bundle.css']){
    const text=fs.readFileSync(path.resolve(__dirname,'../..',rel),'utf8');
    for(const bad of legacy)assert.equal(text.includes(bad),false,rel+' contains forbidden substring '+bad);
    if(rel.endsWith('.js')){
      assert.doesNotMatch(text,/innerHTML|insertAdjacentHTML|outerHTML/);
      const fns=javascriptFunctions(text);
      for(const fn of fns)assert.ok(fn.ccn<=15,rel+':'+fn.id+' CCN='+fn.ccn+' exceeds 15');
    }else{
      assert.match(text,/max-width:\s*100%/);
      assert.match(text,/min-width:\s*0/);
      assert.match(text,/flex-wrap:\s*wrap/);
      assert.match(text,/white-space:\s*normal/);
    }
  }
});
