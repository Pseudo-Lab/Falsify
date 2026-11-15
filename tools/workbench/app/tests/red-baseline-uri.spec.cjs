'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const ROOT=path.resolve(__dirname,'../..');
const TAX=require('../dist/adversarial-taxonomy.js');
const SENSOR=require('../dist/blue-defect-sensor-core.js');
const RBU=require('../dist/red-baseline-uri.js');

function buildTestPdf(uris){
  const objs=[];
  objs.push('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
  objs.push('2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n');
  const annotRefs=uris.map((_,i)=>(4+i)+' 0 R').join(' ');
  objs.push('3 0 obj\n<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R/Annots['+annotRefs+']>>\nendobj\n');
  uris.forEach((uri,i)=>{
    objs.push((4+i)+' 0 obj\n<</Type/Annot/Subtype/Link/Rect[70 '+(700-i*30)+' 320 '+(718-i*30)+']/A<</S/URI/URI('+uri+')>>>>\nendobj\n');
  });
  let pdf='%PDF-1.7\n';
  const offsets=[0];
  for(const o of objs){offsets.push(pdf.length);pdf+=o;}
  const xrefOffset=pdf.length;
  pdf+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n';
  for(let i=1;i<offsets.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  pdf+='trailer\n<</Size '+offsets.length+'/Root 1 0 R>>\nstartxref\n'+xrefOffset+'\n%%EOF\n';
  return Buffer.from(pdf,'latin1');
}

function makeMockElement(doc,tag){
  const el=new EventTarget();
  const classes=new Set();
  const attrs=new Map();
  let _id='';
  Object.defineProperty(el,'id',{
    enumerable:true,
    get(){return _id;},
    set(v){_id=v;if(v)doc._byId.set(v,el);},
  });
  Object.defineProperty(el,'className',{
    enumerable:true,
    get(){return [...classes].join(' ');},
    set(v){classes.clear();String(v||'').split(/\s+/).filter(Boolean).forEach(c=>classes.add(c));},
  });
  Object.assign(el,{
    tagName:String(tag||'div').toUpperCase(),
    hidden:false,disabled:false,value:'',textContent:'',placeholder:'',type:'',maxLength:0,
    children:[],dataset:{},style:{},
    classList:{
      add:(...c)=>c.forEach(x=>classes.add(x)),
      remove:(...c)=>c.forEach(x=>classes.delete(x)),
      toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},
      contains:c=>classes.has(c),
    },
    setAttribute(k,v){attrs.set(k,String(v));if(k==='id')el.id=String(v);},
    getAttribute(k){return attrs.get(k)??null;},
    append(...nodes){for(const n of nodes){if(n&&typeof n==='object'){n.parentElement=el;this.children.push(n);}}},
    prepend(...nodes){for(let i=nodes.length-1;i>=0;i--){const n=nodes[i];if(n&&typeof n==='object'){n.parentElement=el;this.children.unshift(n);}}},
    after(...nodes){
      const p=this.parentElement;if(!p)return;
      const idx=p.children.indexOf(this);
      const list=nodes.filter(n=>n&&typeof n==='object');
      list.forEach(n=>{n.parentElement=p;});
      p.children.splice(idx+1,0,...list);
    },
    replaceChildren(...nodes){this.children=[];this.append(...nodes);},
    remove(){const p=this.parentElement;if(p)p.children=p.children.filter(c=>c!==this);this.parentElement=null;},
    click(){if(!this.disabled)this.dispatchEvent(new Event('click',{bubbles:true}));},
    getClientRects(){return [{}];},
    querySelector(sel){return this.querySelectorAll(sel)[0]||null;},
    querySelectorAll(sel){
      const out=[];
      const match=node=>{
        if(sel==='.red-ab p')return node.tagName==='P'&&node.parentElement?.classList?.contains('red-ab');
        if(sel==='.check-row span')return node.tagName==='SPAN'&&node.parentElement?.classList?.contains('check-row');
        if(sel.startsWith('#'))return node.id===sel.slice(1);
        if(sel.startsWith('.'))return node.classList?.contains(sel.slice(1));
        if(sel==='[data-view=blue]'||sel==='[data-view="blue"]')return node.dataset?.view==='blue';
        return node.tagName===sel.toUpperCase();
      };
      const walk=node=>{for(const c of node.children||[]){if(match(c))out.push(c);walk(c);}};
      walk(this);
      return out;
    },
  });
  return el;
}

function mountMockWorkbench(){
  const doc=new EventTarget();
  doc._byId=new Map();
  doc.body=makeMockElement(doc,'body');
  doc.createElement=tag=>makeMockElement(doc,tag);
  doc.getElementById=id=>doc._byId.get(id)||null;
  doc.querySelector=sel=>doc.body.querySelector(sel);
  doc.querySelectorAll=sel=>doc.body.querySelectorAll(sel);

  const wb=makeMockElement(doc,'section');wb.id='view-workbench';
  const step1=makeMockElement(doc,'section');step1.className='role-step';
  const step2=makeMockElement(doc,'section');step2.className='role-step';
  const docRed=makeMockElement(doc,'section');docRed.id='document-red';
  const cands=makeMockElement(doc,'div');cands.id='red-candidates';
  const blueNav=makeMockElement(doc,'button');blueNav.dataset.view='blue';
  let blueNavClicked=0;blueNav.addEventListener('click',()=>{blueNavClicked++;});
  step2.append(docRed);
  wb.append(step1,step2,cands);
  doc.body.append(wb,blueNav);

  const downloads=[],blueEvents=[];
  doc.addEventListener('falsify:blue-file',e=>blueEvents.push(e));
  class MockBlob{constructor(parts,opts){this.parts=parts;this.type=opts?.type||'';}}
  class MockFile{constructor(parts,name,opts){this.parts=parts;this.name=name;this.type=opts?.type||'';}}
  class MockURL extends URL{}
  MockURL.createObjectURL=b=>{downloads.push(b);return 'blob:'+downloads.length;};
  MockURL.revokeObjectURL=()=>{};
  const ctx=vm.createContext({
    document:doc,FalsifyBlueDefectSensor:SENSOR,FalsifyAdversarialTaxonomy:TAX,
    CustomEvent,Event,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,URL:MockURL,
    Blob:MockBlob,File:MockFile,Promise,Error,Map,Set,JSON,Number,String,Object,setTimeout,
  });
  const src=fs.readFileSync(path.resolve(__dirname,'../dist/red-baseline-uri.js'),'utf8');
  vm.runInContext(src,ctx,{filename:'red-baseline-uri.js'});
  return {doc,wb,cands,downloads,blueEvents,getBlueNavClicks:()=>blueNavClicked,api:ctx.FalsifyRedBaselineUri};
}

const flush=async(n=6)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};

test('checkBaselineOverlap detects pre-existing D1/D2 flaws and flags overlapping candidates',()=>{
  const clean=RBU.checkBaselineOverlap({
    segments:[{id:'s0',pageIndex:0,text:'Patients received 50 mg daily with normal outcome.'}],
    candidates:[{id:'c0',segmentId:'s0',before:'50 mg daily',after:'100 mg daily'}],
  });
  assert.equal(clean.counts.total,0);
  assert.equal(clean.hasOverlap,false);

  const flawed=RBU.checkBaselineOverlap({
    segments:[
      {id:'s0',pageIndex:0,text:'Cohort showed t(28) = 2.50, p = 0.25 in baseline [5]. Healthy control had 10/20 (50%) response.'},
      {id:'s1',pageIndex:1,text:'References\n[1] Doe J. Study A. doi:10.1000/study-a\n[2] Roe K. Study B. doi:10.1000/bad..doi'},
    ],
    candidates:[
      {id:'c1',segmentId:'s0',before:'t(28) = 2.50, p = 0.25',after:'t(28) = 2.50, p = 0.01'},
      {id:'c2',segmentId:'s0',before:'10/20 (50%) response',after:'12/20 (60%) response'},
    ],
  });
  assert.ok(flawed.counts.d1>=1);
  assert.ok(flawed.counts.d2>=1);
  assert.equal(flawed.overlaps.length,1);
  assert.equal(flawed.overlaps[0].candidateId,'c1');
  assert.equal(flawed.overlaps[0].message,'주의: 원본 기존 오류 의심 구간과 겹침');
});

test('DOM mount never adds .role-step, renders Baseline Guard, badges overlapping cards, and hands blind PDF to BLUE',async()=>{
  const w=mountMockWorkbench();
  const panel=w.doc.getElementById('red-baseline-uri-panel');
  assert.ok(panel,'panel mounted');
  assert.equal(panel.classList.contains('role-step'),false,'NEVER use .role-step on #red-baseline-uri-panel');
  assert.equal(panel.hidden,true);

  const pdfBytes=buildTestPdf(['https://doi.org/10.1038/s41586-023-00001-1','https://doi.org/10.1126/science.abc1234']);
  const mockFile={name:'sample-paper.pdf',type:'application/pdf',arrayBuffer:async()=>pdfBytes.buffer.slice(pdfBytes.byteOffset,pdfBytes.byteOffset+pdfBytes.byteLength)};
  w.doc.dispatchEvent(new CustomEvent('falsify:document',{
    detail:{
      file:mockFile,
      result:{
        format:'PDF',
        segments:[
          {id:'s0',label:'PDF p. 1',text:'Stat check t(28) = 2.50, p = 0.25. Normal line: n = 40.'},
          {id:'s1',label:'PDF p. 2',text:'References\n[1] Kim J. Paper. doi:10.1038/s41586-023-00001-1\n[2] Lee K. Note. doi:10.1000/bad..doi'},
        ],
      },
    },
  }));
  await flush();
  assert.equal(panel.hidden,false);
  const guardText=w.doc.getElementById('red-baseline-guard-summary').textContent;
  assert.match(guardText,/D1 수치 단서 1건/);
  assert.match(guardText,/D2 서지 단서 1건/);

  // Render two .red-proposal cards: one overlapping D1 stat mismatch, one clean
  const card1=w.doc.createElement('section');card1.className='red-proposal';
  const ab1=w.doc.createElement('div');ab1.className='red-ab';
  const p1=w.doc.createElement('p');p1.textContent='t(28) = 2.50, p = 0.25';
  ab1.append(p1);card1.append(ab1);
  const card2=w.doc.createElement('section');card2.className='red-proposal';
  const ab2=w.doc.createElement('div');ab2.className='red-ab';
  const p2=w.doc.createElement('p');p2.textContent='Normal line: n = 40.';
  ab2.append(p2);card2.append(ab2);
  w.cands.append(card1,card2);
  w.doc.dispatchEvent(new CustomEvent('falsify:document-state',{detail:{name:'sample-paper.pdf',count:2}}));

  assert.equal(card1.querySelectorAll('.red-baseline-overlap-badge').length,1);
  assert.match(card1.querySelector('.red-baseline-overlap-badge').textContent,/주의: 원본 기존 오류 의심 구간과 겹침/);
  assert.equal(card2.querySelectorAll('.red-baseline-overlap-badge').length,0);

  // Enter replacement URL in /URI UI and hand blind File to BLUE
  const uriInputs=panel.querySelectorAll('.red-uri-input');
  assert.equal(uriInputs.length,2);
  uriInputs[0].value='https://doi.org/10.1038/s41586-019-99999-8';
  uriInputs[0].dispatchEvent(new Event('input'));
  w.doc.getElementById('red-uri-handoff-blue').click();
  await flush();
  assert.equal(w.blueEvents.length,1);
  const handed=w.blueEvents[0].detail.file;
  assert.equal(handed.type,'application/pdf');
  assert.equal(Object.hasOwn(w.blueEvents[0].detail,'changes'),false,'zero answer-key metadata in BLUE handoff');
  assert.equal(w.getBlueNavClicks(),1);

  w.doc.dispatchEvent(new Event('falsify:document-clear'));
  assert.equal(panel.hidden,true);
});

test('pure-JS inspectPdfUriEntries and mutatePdfUriBytes roundtrip updates xref cleanly and enforces blindness gate',()=>{
  const origA='https://doi.org/10.1000/short';
  const origB='https://example.org/original-second-link';
  const raw=buildTestPdf([origA,origB]);
  const inspected=RBU.inspectPdfUriEntries(raw);
  assert.equal(inspected.linkCount,2);
  assert.equal(inspected.entries[0].uri,origA);
  assert.equal(inspected.entries[1].uri,origB);

  const nextA='https://doi.org/10.1038/much-longer-replacement-doi-2026-xyz';
  const mutated=RBU.mutatePdfUriBytes(raw,[{index:0,beforeUri:origA,afterUri:nextA}]);
  assert.equal(mutated.appliedCount,1);
  const reInspected=RBU.inspectPdfUriEntries(mutated.bytes);
  assert.equal(reInspected.linkCount,2);
  assert.equal(reInspected.entries[0].uri,nextA);
  assert.equal(reInspected.entries[1].uri,origB);

  // Verify xref offsets and startxref point exactly to objects and xref table
  const text=Buffer.from(mutated.bytes).toString('latin1');
  const startMatch=/startxref\r?\n(\d+)/.exec(text);
  assert.ok(startMatch);
  const xrefPos=Number(startMatch[1]);
  assert.equal(text.slice(xrefPos,xrefPos+4),'xref');
  const xrefLines=text.slice(xrefPos).split(/\r?\n/).filter(l=>/^\d{10} 00000 n/.test(l));
  assert.equal(xrefLines.length,5);
  xrefLines.forEach((line,idx)=>{
    const off=Number(line.slice(0,10));
    assert.ok(text.slice(off).startsWith((idx+1)+' 0 obj'),'xref offset points to obj '+(idx+1));
  });

  // Blindness gate rejections
  for(const bad of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'mailto:user@example.com',
    'https://doi.org/10.1000/intentional-swap',
    'https://doi.org/10.1000/fabricated',
    'https://doi.org/10.1000/fake-doi',
    'https://example.org/red-team',
    'https://example.org/injected',
    'https://example.org/변조',
    'https://example.org/가짜',
    'https://example.org/함정',
    'https://example.org/a(b)',
    'https://example.org/with space',
  ]){
    assert.throws(()=>RBU.mutatePdfUriBytes(raw,[{index:0,afterUri:bad}]),/./,'expected rejection for '+bad);
  }
});

test('static invariants: no innerHTML/legacy tokens and CCN <= 15 on owned files',async()=>{
  const jsSrc=fs.readFileSync(path.join(ROOT,'app/dist/red-baseline-uri.js'),'utf8');
  const cssSrc=fs.readFileSync(path.join(ROOT,'app/dist/red-baseline-uri.css'),'utf8');
  for(const forbidden of [
    'innerHTML','outerHTML','insertAdjacentHTML',
    'load-sample','FalsifyCore','SAMPLE_PROFILES','generateRed','runBlue',
    'connectAgent','exportDemo','connectorTimers','legacy-review','blue-mode',
    'blue-outcome','activity-log','doc-blue-comparison',
  ]){
    assert.equal(jsSrc.includes(forbidden),false,'js must not contain '+forbidden);
    assert.equal(cssSrc.includes(forbidden),false,'css must not contain '+forbidden);
  }
  const {javascriptFunctions}=await import('../../tools/quality/complexity.mjs');
  const fns=javascriptFunctions(jsSrc);
  const over=fns.filter(f=>f.ccn>15);
  assert.equal(over.length,0,'expected CCN <= 15 for all functions, got: '+JSON.stringify(over));
});
