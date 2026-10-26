import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {detectSourceTables,selectTableCell,readMuPdfTablePages,TableModel,tableGeometry} from '../src/table-adapter.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=new TextEncoder().encode('%PDF-fixture');
const run=(id,text,x,y,w=25)=>({id,text,bbox:[x,y,x+w,y+10]});
const page=(runs,rules=[])=>({pageIndex:0,width:400,height:500,rotation:0,coordinateSpace:'top-left-page',runs,rules});
const grid=(xs=[40,160,280],ys=[40,70,100,130])=>[
  ...xs.map(x=>({bbox:[x-.25,ys[0],x+.25,ys.at(-1)]})),
  ...ys.map(y=>({bbox:[xs[0],y-.25,xs.at(-1),y+.25]})),
];
const rows=(labels=['Name','Alpha','Beta'],values=['Value','10','10'])=>labels.flatMap((s,i)=>[run('l'+i,s,50,50+i*30,40),run('r'+i,values[i],170,50+i*30,30)]);
const inspect=async(p,extra={})=>detectSourceTables({sourceBytes:bytes,sourceSha256:sha(bytes),revision:'r1',readPages:async copy=>{assert.notEqual(copy,bytes);assert.deepEqual(copy,bytes);return [p];},...extra});
const choose=(m,c,t=m.tables[0])=>selectTableCell(m,{tableId:t.id,cellId:c.id,sourceSha256:m.sourceSha256,revision:m.revision});

test('ruled source table returns exact text and tight anchor; repeated numbers have distinct identities',async()=>{
  const m=await inspect(page(rows(),grid()));assert.equal(m.tables.length,1);const t=m.tables[0];assert.equal(t.ruled,true);assert.equal(t.rows,3);assert.equal(t.cols,2);
  const cells=t.cells.filter(c=>c.col===1&&c.row>0),a=choose(m,cells[0]),b=choose(m,cells[1]);
  assert.equal(a.status,'ready');assert.equal(a.before,'10');assert.equal(b.status,'ready');assert.notEqual(a.cellId,b.cellId);assert.notDeepEqual(a.anchor.bbox,b.anchor.bbox);
  assert.deepEqual(a.anchor.bbox,[170,80,200,90]);assert.notDeepEqual(a.anchor.bbox,a.cellBbox);assert.equal(a.anchor.coordinateSpace,'top-left-page');assert.equal(a.anchor.occurrence,undefined);
  assert.ok(Object.isFrozen(m.tables[0].cells[0].bbox));
});
test('borderless numeric table detected; aligned normal two-column prose and headers rejected',async()=>{
  assert.equal((await inspect(page(rows()))).tables.length,1);
  const prose=rows(['Long prose line one','Another prose line','Final prose line'],['Other column prose','Further prose here','Last prose sentence']);
  assert.equal((await inspect(page(prose))).tables.length,0);
  assert.equal((await inspect(page([run('h','Results',50,10,180),...prose]))).tables.length,0);
});
test('merged columns use source missing boundary and retain a span',async()=>{
  // Adapted from the pinned upstream merged-grid regression, using top-left
  // coordinates at our boundary. Covers a down merge as well as colspan.
  const xs=[36,132,321,393,473,576],ys=[159,193,231,285,327,369,423,461];
  const texts=[['Workstream','Task','Owner','State','Hours'],['North programme','','Ada','Active','18.5'],['Ops','Archive intake','Lin','Ready','7.0'],['','Metadata review','Sam','Review','12.5'],['QA','Needs sign-off','Jo','Hold','4.0'],['Docs','Export proof','May','','3.25'],['Shared checkpoint','','','Review','45.25']];
  const spans=[{row:1,col:0,rowSpan:1,colSpan:2},{row:2,col:0,rowSpan:2,colSpan:1},{row:6,col:0,rowSpan:1,colSpan:3}],runs=[],rules=[];
  for(let r=0;r<texts.length;r++)for(let c=0;c<5;c++){const text=texts[r][c];if(!text)continue;const span=spans.find(s=>s.row===r&&s.col===c),w=text.length*5.5,x=c===4&&r>0?xs[c+1]-10-w:xs[c]+10,y=(ys[r]+ys[r+(span?.rowSpan??1)])/2-6;runs.push({...run(`r${r}c${c}`,text,x,y,w),bbox:[x,y,x+w,y+12]});}
  for(let c=0;c<xs.length;c++)for(let r=0;r<texts.length;r++){if(spans.some(s=>s.row<=r&&r<s.row+s.rowSpan&&s.col<c&&c<s.col+s.colSpan))continue;rules.push({bbox:[xs[c]-.25,ys[r],xs[c]+.25,ys[r+1]]});}
  for(let r=0;r<ys.length;r++)for(let c=0;c<5;c++){if(spans.some(s=>s.row<r&&r<s.row+s.rowSpan&&s.col<=c&&c<s.col+s.colSpan))continue;rules.push({bbox:[xs[c],ys[r]-.25,xs[c+1],ys[r]+.25]});}
  const m=await inspect({...page(runs,rules),width:650,height:800});assert.equal(m.tables.length,1);assert.ok(m.tables[0].cells.some(c=>c.colSpan===2));assert.ok(m.tables[0].cells.some(c=>c.rowSpan===2));
});
test('overlapping duplicate text does not become a ready edit',async()=>{
  const rs=rows();rs.push(run('overprint','10',170,80,30));const m=await inspect(page(rs,grid()));
  const t=m.tables[0],cell=t.cells.find(c=>c.row===1&&c.col===1);assert.equal(choose(m,cell).status,'unsupported');
});
test('stale hash and revision rejected; identity deterministic and revision-bound',async()=>{
  const p=page(rows(),grid()),a=await inspect(p),b=await inspect(p);assert.equal(a.tables[0].id,b.tables[0].id);
  await assert.rejects(()=>inspect(p,{sourceSha256:'0'.repeat(64)}),{code:'stale-source'});
  assert.throws(()=>selectTableCell(a,{tableId:a.tables[0].id,cellId:a.tables[0].cells[0].id,sourceSha256:a.sourceSha256,revision:'r2'}),{code:'stale-selection'});
  const c=await inspect(p,{revision:'r2'});assert.notEqual(a.tables[0].id,c.tables[0].id);
  assert.throws(()=>selectTableCell(JSON.parse(JSON.stringify(a)),{}),{code:'unverified-model'});
});
test('rotated pages and malformed or duplicate run identities cannot yield editable cells',async()=>{
  assert.equal((await inspect({...page(rows(),grid()),rotation:90})).tables.length,0);
  await assert.rejects(()=>inspect(page([...rows(),run('r1','other',10,10)])),{code:'invalid-run'});
  await assert.rejects(()=>inspect({...page(rows()),coordinateSpace:'bottom-left'}),{code:'invalid-page'});
});
test('minimal imported model and geometry remain engine-free and preserve merged cells',()=>{
  const m=new TableModel({id:'t',pageIndex:0,colEdges:[0,40,80],rowEdges:[80,40,0],cellRuns:[['a',null],['b','c']],cellSpans:[[{rowSpan:1,colSpan:2},null],[null,null]],hLinePtrs:[],vLinePtrs:[],lineWidth:1,fontSize:11});
  assert.deepEqual(m.cellRect(0,0),{x:0,y:40,width:80,height:40});assert.equal(m.snapshot().cells.length,3);
  assert.deepEqual(tableGeometry.insertColumnEdges([0,40,80],1,20).edges,[0,40,60,100]);
});

// Small real PDF proof, no private papers or model calls. Dependencies reuse
// the coordinator's existing installation; override for another checkout.
const depRoot=process.env.FALSIFY_TEST_WORKBENCH||resolve(import.meta.dirname,'../..');
const mupdf=await import(pathToFileURL(resolve(depRoot,'app/node_modules/mupdf/dist/mupdf.js')).href);
function pdf(body){
  const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let out='%PDF-1.4\n',offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(out));
}
function realTable(){let body='0 0 0 RG .5 w\n';for(const x of [40,160,280])body+=`${x} 370 m ${x} 460 l S\n`;for(const y of [370,400,430,460])body+=`40 ${y} m 280 ${y} l S\n`;for(const [i,left,right]of [[0,'Name','Value'],[1,'Alpha','10'],[2,'Beta','10']])for(const [x,s]of [[50,left],[170,right]])body+=`BT /F1 10 Tf 1 0 0 1 ${x} ${440-i*30} Tm (${s}) Tj ET\n`;return pdf(body);}
test('actual MuPDF source extraction finds ruled cells and exact repeated quote anchors',async()=>{
  const source=realTable(),raw=readMuPdfTablePages(source,mupdf);assert.equal(raw[0].runs.length,6);assert.equal(raw[0].rules.length,7);
  const m=await detectSourceTables({sourceBytes:source,sourceSha256:sha(source),revision:'real',mupdf});assert.equal(m.tables.length,1);
  const cells=m.tables[0].cells.filter(c=>c.col===1&&c.row>0);assert.equal(cells.length,2);for(const c of cells){const s=choose(m,c);assert.equal(s.status,'ready');assert.equal(s.before,'10');}
});
test('source cell anchor feeds current browser writer; other duplicate and source remain unchanged',async()=>{
  const source=realTable(),copy=source.slice(),m=await detectSourceTables({sourceBytes:source,sourceSha256:sha(source),revision:'real',mupdf});
  const cell=m.tables[0].cells.find(c=>c.row===1&&c.col===1),selection=choose(m,cell);assert.equal(selection.status,'ready');
  const {prepare}=await import(pathToFileURL(resolve(depRoot,'app/dist/browser-pdf.mjs')).href);
  const result=await prepare({file:source,fileHash:sha(source),edits:[{id:cell.id,pageIndex:selection.pageIndex,before:selection.before,after:'11',anchor:selection.anchor}]});
  assert.deepEqual(source,copy);assert.equal(result.verification.edits[0].status,'applied');
  const output=new Uint8Array(await result.file.arrayBuffer());assert.ok(output instanceof Uint8Array);
  const after=readMuPdfTablePages(output,mupdf),texts=after[0].runs.map(r=>r.text);assert.equal(texts.filter(t=>t==='10').length,1);assert.equal(texts.filter(t=>t==='11').length,1);
});
test('twelve repeated real numeric cells: last cell edits successfully without an occurrence ordinal',async()=>{
  let body='0 0 0 RG .5 w\n';for(const x of [40,160,280])body+=`${x} 180 m ${x} 460 l S\n`;for(let i=0;i<=14;i++)body+=`40 ${460-i*20} m 280 ${460-i*20} l S\n`;
  for(let i=0;i<13;i++)for(const [x,s]of [[50,i?'Row'+i:'Name'],[170,i?'10':'Value']])body+=`BT /F1 8 Tf 1 0 0 1 ${x} ${447-i*20} Tm (${s}) Tj ET\n`;
  const source=pdf(body),m=await detectSourceTables({sourceBytes:source,sourceSha256:sha(source),revision:'many',mupdf});assert.equal(m.tables.length,1);
  const cell=m.tables[0].cells.find(c=>c.row===12&&c.col===1),selection=choose(m,cell);assert.equal(selection.status,'ready');assert.equal(selection.anchor.occurrence,undefined);
  const {prepare}=await import(pathToFileURL(resolve(depRoot,'app/dist/browser-pdf.mjs')).href);
  const result=await prepare({file:source,fileHash:sha(source),edits:[{id:'last-number',pageIndex:0,before:selection.before,after:'11',anchor:selection.anchor}]});assert.equal(result.verification.edits[0].status,'applied');
  const after=readMuPdfTablePages(new Uint8Array(await result.file.arrayBuffer()),mupdf),numbers=after[0].runs.filter(r=>r.text==='10'||r.text==='11');
  assert.equal(numbers.filter(r=>r.text==='10').length,11);assert.equal(numbers.filter(r=>r.text==='11').length,1);assert.ok(Math.abs(numbers.find(r=>r.text==='11').bbox[1]-selection.anchor.bbox[1])<0.1);
});
