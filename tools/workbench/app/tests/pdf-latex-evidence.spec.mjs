import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {extractReconstructionEvidence,buildReconstructionModel} from '../src/pdf-latex-evidence.mjs';

function synthetic(){
  const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const line=(s,y)=>`BT /F 11 Tf 30 ${y} Td (${s}) Tj ET\n`;
  const stream=line('Group A: 42 participants.',350)+line('Group B: 42 participants.',320)+line('Group A: 43 participants.',290);
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},stream));
  const buffer=d.saveToBuffer(),bytes=buffer.asUint8Array().slice();buffer.destroy();d.destroy();return bytes;
}
const extract=bytes=>extractReconstructionEvidence({bytes,sourceSha256:hex(bytes)});
test('actual PDF observations are deterministic, immutable and preserve contradictions and every occurrence',async()=>{
  const bytes=synthetic(),copy=bytes.slice(),a=await extract(bytes),b=await extract(bytes);
  assert.deepEqual(bytes,copy);assert.deepEqual(a,b);
  const model=buildReconstructionModel(a);assert.deepEqual(model,buildReconstructionModel(b));
  const text=model.items.map(i=>i.text||'').join(' ');
  assert.match(text,/Group A: 42 participants/);assert.match(text,/Group B: 42 participants/);assert.match(text,/Group A: 43 participants/);
  const segments=model.items.flatMap(i=>i.extensions.segments);
  for(const s of segments){const e=s.evidence;assert.equal(a.document.pages[e.pageIndex].text.slice(e.range.start,e.range.end),s.text);}
  assert.equal(segments.reduce((n,s)=>n+s.text.length,0),a.document.pages[0].text.length);
  assert.equal(new Set(model.items.map(i=>i.id)).size,model.items.length);
});
test('mixed scripts, image ownership, and caption remain separate source evidence',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url))),input=await extract(bytes),model=buildReconstructionModel(input);
  const sentence=model.items.find(i=>i.text?.includes('An initial claim62'));
  assert.equal(sentence.reason,'inline-script-candidate');assert.ok(sentence.extensions.candidates.some(c=>c.kind==='script'));
  assert.ok(sentence.extensions.candidates.some(c=>c.kind==='citation'));
  assert.ok(model.items.some(i=>i.kind==='figure'&&i.status==='unsupported'));
  const segments=model.items.flatMap(i=>i.extensions.segments),ids=segments.flatMap(s=>[s.evidence.blockId+':'+s.evidence.range.start+':'+s.evidence.range.end]);
  assert.equal(ids.length,new Set(ids).size);
  assert.ok(model.items.some(i=>i.text?.includes('Figure 1: Synthetic unchanged figure.')));
  assert.ok(model.pages.every(p=>p.frame==='mupdf-display'&&p.transform.length===6));
});
test('invalid hash, cancellation, frame, tampered ranges and duplicated ownership fail closed',async()=>{
  const bytes=synthetic();await assert.rejects(extractReconstructionEvidence({bytes,sourceSha256:'0'.repeat(64)}),{code:'stale-source'});
  const c=new AbortController();c.abort();await assert.rejects(extractReconstructionEvidence({bytes,sourceSha256:hex(bytes),signal:c.signal}),{name:'AbortError'});
  const a=await extract(bytes),bad=structuredClone(a);bad.document.pages[0].geometry.frame='unknown';assert.throws(()=>buildReconstructionModel(bad),{code:'invalid-page-frame'});
  const stale=structuredClone(a);stale.flow.sourceSha256='0'.repeat(64);assert.throws(()=>buildReconstructionModel(stale),{code:'stale-evidence'});
  const range=structuredClone(a);range.document.blocks.find(b=>b.text).text+='X';assert.throws(()=>buildReconstructionModel(range),{code:'invalid-evidence'});
  const dup=structuredClone(a);dup.flow.items.push({...structuredClone(dup.flow.items[0]),id:'duplicate'});assert.throws(()=>buildReconstructionModel(dup),{code:'ambiguous-provenance'});
});

test('page budget is enforced before native extraction and cancellation is observed between pages',async()=>{
  const d=new mupdf.PDFDocument();
  for(let i=0;i<101;i++)d.insertPage(-1,d.addPage([0,0,100,100],0,{},''));
  const buffer=d.saveToBuffer(),bytes=buffer.asUint8Array().slice();buffer.destroy();d.destroy();
  await assert.rejects(extract(bytes),{code:'budget-exceeded'});
  const d2=new mupdf.PDFDocument();for(let i=0;i<5;i++)d2.insertPage(-1,d2.addPage([0,0,100,100],0,{},''));
  const b=d2.saveToBuffer(),short=b.asUint8Array().slice();b.destroy();d2.destroy();
  const controller=new AbortController(),pending=extractReconstructionEvidence({bytes:short,sourceSha256:hex(short),signal:controller.signal});
  setTimeout(()=>controller.abort(),0);await assert.rejects(pending,{name:'AbortError'});
});

// A 36-page model exercises thousands of independently owned source ranges;
// its geometry and text are synthetic and it is not a substitute for PDF parsing.
function largeEvidence(pageCount=36,perPage=56,textWidth=72){
  const hash='a'.repeat(64),pages=[],blocks=[],items=[],frames=[];
  for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
    let text='';const geometry={frame:'mupdf-display',bounds:[0,0,612,792],pageTransform:[1,0,0,-1,0,792]};
    for(let i=0;i<perPage;i++){
      const value=textWidth===1?'x':`Page ${pageIndex} block ${i} value 42. `.padEnd(textWidth,'x'),start=text.length; text+=value;
      const id=`b-${pageIndex}-${i}`,bbox=[20,20+i*10,400,29+i*10],source={pageIndex,bbox,range:{start,end:text.length},characters:[],lines:[]};
      blocks.push({id,text:value,source});items.push({id:`f-${pageIndex}-${i}`,kind:'paragraph',blockIds:[id],assetIds:[],source:{pageIndex,bbox},columns:1,span:'page'});
    }
    pages.push({sourcePageIndex:pageIndex,width:612,height:792,text,geometry});frames.push({pageIndex,bounds:geometry.bounds,pageTransform:geometry.pageTransform,verified:true});
  }
  return {document:{schema:'falsify.paper-document.v1',sourceSha256:hash,pages,blocks,assets:[],styles:[],diagnostics:[]},flow:{schema:'falsify.paper-flow.v1',sourceSha256:hash,items,fragments:[],regions:[],relations:[],diagnostics:[]},links:{schema:'falsify.paper-source-links.v1',sourceSha256:hash,frames,links:[]},assets:{sourceSha256:hash,assets:[],diagnostics:[]}};
}
test('36-page evidence keeps all 2016 blocks and exact text within finite budgets',()=>{
  const evidence=largeEvidence(),model=buildReconstructionModel(evidence);
  assert.equal(model.items.length,2016);
  assert.equal(model.items.reduce((n,item)=>n+item.text.length,0),36*56*72);
  assert.equal(new Set(model.items.map(item=>item.id)).size,2016);
  const limit=largeEvidence(1,8000,1);assert.equal(buildReconstructionModel(limit).items.length,8000);
  const exceeded=largeEvidence(1,8001,1);assert.throws(()=>buildReconstructionModel(exceeded),{code:'budget-exceeded'});
});
test('proposed inter-block whitespace survives while source ranges remain exact',()=>{
  const evidence=largeEvidence(1,3,1),[first,second,untouched]=evidence.flow.items;
  first.blockIds.push(second.blockIds[0]);first.inline=true;first.joiners=[' '];
  evidence.flow.items=[first,untouched];
  const model=buildReconstructionModel(evidence),item=model.items[0];
  assert.equal(item.text,'x x');assert.equal(model.items[1].text,'x');
  assert.deepEqual(item.extensions.segments.map(s=>s.text),['x','x']);
  for(const segment of item.extensions.segments){const e=segment.evidence;assert.equal(evidence.document.pages[e.pageIndex].text.slice(e.range.start,e.range.end),segment.text);}
  assert.equal(item.reason,'flow-joiner-unverified');
  const invalid=structuredClone(evidence);invalid.flow.items[0].joiners=[' injected '];
  assert.throws(()=>buildReconstructionModel(invalid),{code:'invalid-evidence'});
});
test('indexed range ownership still rejects overlapping fragments and missing source text',async()=>{
  const evidence=await extract(synthetic()),item=evidence.flow.items.find(x=>x.blockIds.length===1&&evidence.document.blocks.find(b=>b.id===x.blockIds[0]&&b.text));
  const missing=structuredClone(evidence);missing.flow.items=missing.flow.items.filter(x=>x.id!==item.id);assert.throws(()=>buildReconstructionModel(missing),{code:'uncovered-source-text'});
  const overlap=structuredClone(evidence),parent=overlap.document.blocks.find(b=>b.id===item.blockIds[0]),r=parent.source.range;
  const fragment={...structuredClone(parent),id:'overlap-fragment',parentBlockId:parent.id,source:{...structuredClone(parent.source),range:{...r}}};
  overlap.flow.fragments.push(fragment);overlap.flow.items.push({...structuredClone(item),id:'overlap-flow',blockIds:[fragment.id]});
  assert.throws(()=>buildReconstructionModel(overlap),{code:'ambiguous-provenance'});
});

test('drawing observation budget remains finite',async()=>{
  const d=new mupdf.PDFDocument(),stream='1 w\n'+'0 0 m 20 20 l S\n'.repeat(50001);
  d.insertPage(-1,d.addPage([0,0,100,100],0,{},stream));const b=d.saveToBuffer(),bytes=b.asUint8Array().slice();b.destroy();d.destroy();
  await assert.rejects(extract(bytes),{code:'budget-exceeded'});
});

test('typography weighs observed non-whitespace glyphs and estimates only consistent line spacing',async()=>{
  const {normalizeDocument}=await import('../src/paper-document.mjs'),hash='b'.repeat(64);
  const make=(lines,x,y)=>{
    const chars=[],ls=[];
    for(const [row,[text,offset,small]] of lines.entries()){
      const start=chars.length;
      for(const [j,ch] of [...text].entries()){
        const sup=small?.includes(j),top=y+offset-(sup?3:0),size=sup?6:9;
        chars.push({text:ch,bbox:[x+j*5,top,x+j*5+4,top+size],fontName:sup?'Small':'Body',size});
      }
      ls.push({start,end:chars.length,bbox:[x,y+offset,x+text.length*5,y+offset+9],writingMode:0,direction:[1,0]});
    }
    return {bbox:[x,y,x+100,y+60],chars,lines:ls};
  };
  const body=make([['Alpha 2',0,[6]],['Beta words',12,[]]],20,30);
  body.chars[0].fontName='Body Italic';
  const title=make([['Heading',0,[]]],20,120);for(const c of title.chars){c.size=18;c.fontName='Title';}
  const tie=make([['xy',0,[1]]],20,220);
  const irregular=make([['First',0,[]],['Second',12,[]],['Third',35,[]]],20,300);
  const columns=make([['Left',0,[]],['Right',12,[]]],20,400);for(const c of columns.chars.slice(columns.lines[1].start))c.bbox=[c.bbox[0]+300,c.bbox[1],c.bbox[2]+300,c.bbox[3]];
  const geometry={frame:'mupdf-display',bounds:[0,0,612,792],pageTransform:[1,0,0,-1,0,792]};
  const document=normalizeDocument({sourceSha256:hash,pages:[{width:612,height:792,geometry,blocks:[body,title,tie,irregular,columns],images:[]}]});
  const items=document.blocks.map((b,i)=>({id:`flow-${i}`,kind:i===1?'heading':'paragraph',blockIds:[b.id],assetIds:[],source:{pageIndex:0,bbox:b.source.bbox},columns:1,span:'page'}));
  const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items,fragments:[],regions:[],relations:[],diagnostics:[]};
  const links={schema:'falsify.paper-source-links.v1',sourceSha256:hash,frames:[{pageIndex:0,bounds:geometry.bounds,pageTransform:geometry.pageTransform,verified:true}],links:[]};
  const model=buildReconstructionModel({document,flow,links,assets:{sourceSha256:hash,assets:[],diagnostics:[]}});
  const [bodyItem,titleItem,tieItem,irregularItem,columnsItem]=model.items,typo=bodyItem.extensions.typography;
  assert.equal(typo.fontSizeBp,9);assert.equal(typo.leadingBp,12);assert.equal(typo.status,'proposed');
  assert.deepEqual(typo.styleCounts.map(s=>s.count).sort((a,b)=>a-b),[1,1,13]);
  assert.equal(typo.leadingEvidence.length,2);for(const e of typo.leadingEvidence){assert.equal(e.blockId,bodyItem.evidence[0].blockId);assert.ok(e.range.start>=bodyItem.evidence[0].range.start&&e.range.end<=bodyItem.evidence[0].range.end);assert.ok(Number.isFinite(e.bottomBp));}
  assert.equal(bodyItem.text,'Alpha 2 Beta words');assert.equal(bodyItem.extensions.segments[0].text,document.blocks[0].text);assert.deepEqual(bodyItem.evidence[0].range,document.blocks[0].source.range);
  assert.ok(bodyItem.extensions.inlineRuns.some(r=>r.italic&&bodyItem.text.slice(r.start,r.end)==='A'));
  assert.ok(bodyItem.extensions.inlineRuns.some(r=>r.script==='super'&&bodyItem.text.slice(r.start,r.end)==='2'));
  assert.ok(bodyItem.extensions.inlineRuns.every((r,n,rs)=>!n||rs[n-1].end<=r.start));
  assert.equal(titleItem.extensions.typography.fontSizeBp,18);assert.equal(titleItem.extensions.typography.leadingBp,undefined);
  assert.equal(tieItem.extensions.typography.fontSizeBp,null);assert.equal(tieItem.extensions.typography.leadingBp,undefined);
  assert.equal(irregularItem.extensions.typography.fontSizeBp,9);assert.equal(irregularItem.extensions.typography.leadingBp,undefined);
  assert.equal(columnsItem.extensions.typography.leadingBp,undefined);
});

test('page layout hints retain only a single valid source-flow gutter',()=>{
  const input=largeEvidence(2,3),before=structuredClone(input);
  input.flow.diagnostics.push({code:'geometry-order-heuristic',pageIndex:1,gutter:[280,325]});
  const output=buildReconstructionModel(input);
  assert.equal(output.pages[0].extensions,undefined);
  assert.deepEqual(output.pages[1].extensions.layoutHints,{columns:2,gutterBp:[280,325],status:'proposed',provenance:'paper-flow'});
  assert.deepEqual(input.document,before.document);
  for(const item of output.items)for(const segment of item.extensions.segments){const e=segment.evidence;assert.equal(input.document.pages[e.pageIndex].text.slice(e.range.start,e.range.end),segment.text);}
  const conflict=structuredClone(input);conflict.flow.diagnostics.push({code:'geometry-order-heuristic',pageIndex:1,gutter:[290,330]});
  const conflicting=buildReconstructionModel(conflict);assert.equal(conflicting.pages[1].extensions,undefined);assert.ok(conflicting.diagnostics.some(d=>d.code==='layout-hint-unresolved'&&d.pageIndex===1));
  for(const gutter of [[0,325],[300,300],[300,612],[300,NaN],null]){
    const invalid=structuredClone(input);invalid.flow.diagnostics[0].gutter=gutter;const result=buildReconstructionModel(invalid);
    assert.equal(result.pages[1].extensions,undefined);assert.ok(result.diagnostics.some(d=>d.code==='layout-hint-unresolved'&&d.pageIndex===1));
  }
  const badPage=structuredClone(input);badPage.flow.diagnostics[0].pageIndex=2;const result=buildReconstructionModel(badPage);
  assert.ok(result.pages.every(p=>!p.extensions));assert.ok(result.diagnostics.some(d=>d.code==='layout-hint-unresolved'));
});

test('source line proposals preserve ranges and protect identifiers, formulas and references',async()=>{
  const {normalizeDocument}=await import('../src/paper-document.mjs'),hash='c'.repeat(64);
  const make=(rows,y)=>{const chars=[],lines=[];for(const [row,text] of rows.entries()){const start=chars.length;for(const [i,ch] of [...text].entries())chars.push({text:ch,bbox:[20+i*5,y+row*12,24+i*5,y+row*12+9],fontName:'Body',size:9});lines.push({start,end:chars.length,bbox:[20,y+row*12,20+text.length*5,y+row*12+9],writingMode:0,direction:[1,0]});}return {bbox:[20,y,220,y+rows.length*12],chars,lines};};
  const geometry={frame:'mupdf-display',bounds:[0,0,612,792],pageTransform:[1,0,0,-1,0,792]};
  const document=normalizeDocument({sourceSha256:hash,pages:[{width:612,height:792,geometry,blocks:[make(['A title of','fin-shaped devices'],20),make(['normal prose ','continues here'],70),make(['tightkerning'],120),make(['number 10','20 items'],170),make(['doi:10.1234/ab','cd'],220),make(['x=alpha','beta'],270),make(['References'],320),make(['Smith journal','article'],350),make(['A clear sentence explains a detailed ordinary scientific observation and gives enough context for readers to','understand the result.'],390)],images:[]}]});
  const items=document.blocks.map((b,i)=>({id:`line-${i}`,kind:i===0||i===6?'heading':'paragraph',blockIds:[b.id],assetIds:[],source:{pageIndex:0,bbox:b.source.bbox},columns:1,span:'page'}));
  const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items,fragments:[],regions:[],relations:[],diagnostics:[]},links={schema:'falsify.paper-source-links.v1',sourceSha256:hash,frames:[{pageIndex:0,bounds:geometry.bounds,pageTransform:geometry.pageTransform,verified:true}],links:[]};
  const model=buildReconstructionModel({document,flow,links,assets:{sourceSha256:hash,assets:[],diagnostics:[]}});
  assert.equal(model.items[0].text,'A title of fin-shaped devices');
  for(let i=1;i<7;i++)assert.equal(model.items[i].text,document.blocks[i].text);
  assert.equal(model.items[7].text,'Smith journal article');assert.match(model.items[8].text,/readers to understand/);
  const proseInput=structuredClone({document,flow,links,assets:{sourceSha256:hash,assets:[],diagnostics:[]}});proseInput.flow.items=[...proseInput.flow.items.slice(0,6),proseInput.flow.items[8],...proseInput.flow.items.slice(6,8)];const proseModel=buildReconstructionModel(proseInput);assert.match(proseModel.items[6].text,/readers to understand/);
  const proposal=model.items[0].extensions.separators[0];assert.equal(proposal.method,'source-line-boundary');assert.equal(proposal.status,'proposed');assert.equal(proposal.offset,proposal.before.range.end);assert.equal(proposal.offset,proposal.after.range.start);
  assert.ok(model.diagnostics.some(d=>d.code==='source-line-separator-proposed'&&d.itemId===model.items[0].id));
  for(const item of model.items)for(const segment of item.extensions.segments){const e=segment.evidence;assert.equal(document.pages[e.pageIndex].text.slice(e.range.start,e.range.end),segment.text);}
});
