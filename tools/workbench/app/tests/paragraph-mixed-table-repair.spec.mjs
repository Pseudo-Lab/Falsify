import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import * as selectionPdf from '../dist/browser-pdf.mjs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const paragraphPdf=await import(process.env.PARAGRAPH_CANDIDATE?pathToFileURL(resolve(process.env.PARAGRAPH_CANDIDATE)).href:new URL('../dist/paragraph-pdf.mjs',import.meta.url).href);
import {prepare} from '../src/pdf-edit-pipeline.mjs';
import {inspectTables} from '../dist/table-pdf-worker.mjs';
import {readMuPdfTablePages} from '../src/table-adapter.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture({furniture=false}={}){
 let body='0 0 0 RG .5 w\n';
 for(const x of [40,160,280])body+=`${x} 420 m ${x} 480 l S\n`;
 for(let r=0;r<=3;r++)body+=`40 ${480-r*20} m 280 ${480-r*20} l S\n`;
 for(const [r,row] of [['Group','Value'],['Control','10'],['Treated','10']].entries())for(const [c,x] of [[0,50],[1,170]])body+=`BT /F1 8 Tf ${x} ${467-r*20} Td (${row[c]}) Tj ET\n`;
 body+='BT /F1 10 Tf 40 300 Td (Original body paragraph stays lower on the page.) Tj ET\n';
 if(furniture)body+='BT /F1 7 Tf 40 490 Td (Running header) Tj ET\nBT /F1 7 Tf 200 20 Td (1) Tj ET\n';
 const objs=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
 let pdf='%PDF-1.4\n',off=[0];for(let i=1;i<objs.length;i++){off.push(Buffer.byteLength(pdf));pdf+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}let at=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`+off.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;return new Uint8Array(Buffer.from(pdf));
}
function inspect(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),pages=[];try{for(let i=0;i<d.countPages();i++){const p=d.loadPage(i),s=p.toStructuredText(),lines=[];try{s.walk({beginLine(b){lines.push({box:b,text:''});},onChar(c){lines.at(-1).text+=c;}});pages.push(lines);}finally{s.destroy();p.destroy();}}return pages;}finally{d.destroy();}}
function tableRasterHash(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(0),pix=p.toPixmap([3,0,0,3,0,0],mupdf.ColorSpace.DeviceRGB,false);try{const pixels=pix.getPixels(),stride=pix.getStride(),h=createHash('sha256');for(let y=0;y<300;y++)h.update(pixels.subarray(y*stride,(y+1)*stride));return h.digest('hex');}finally{pix.destroy();p.destroy();d.destroy();}}
test('same-page table and body edits preserve table and fit naturally',{timeout:120000},async()=>{
 const bytes=fixture(),sourceHash=hash(bytes),tables=await inspectTables({bytes:bytes.buffer.slice(0),fileHash:sourceHash,revision:'test',pageIndex:0});
 const cell=tables.cells.find(c=>c.row===1&&c.col===1&&c.selection.status==='ready');assert.ok(cell);
 const edit={id:'cell',segmentId:'table:0:cell',pageIndex:0,before:cell.selection.before,after:'11',anchor:cell.selection.anchor};
 const body={id:'body',segmentId:'paragraph:0:body',pageIndex:0,before:'Original body paragraph stays lower on the page.',after:'Changed body paragraph stays lower on the page.',anchor:{bbox:[40,190,300,210]}};
 const saved=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);if(u.protocol==='file:'){const {readFileSync}=await import('node:fs');return new Response(readFileSync(u));}return saved(input);};
 try{
 await assert.rejects(()=>prepare({file:new File([bytes],'fixture.pdf'),fileHash:sourceHash,edits:[edit,{...body,anchor:{bbox:edit.anchor.bbox}}]},{selectionPdf,paragraphPdf}),{code:'overlapping-edits'});
 let aBytes;const a={prepare:async r=>{const v=await selectionPdf.prepare(r);aBytes=new Uint8Array(await v.file.arrayBuffer());return v;}};
 const out=await prepare({file:new File([bytes],'fixture.pdf'),fileHash:sourceHash,edits:[edit,body]},{selectionPdf:a,paragraphPdf});
 if(process.env.DEBUG_MIXED)console.log(JSON.stringify({report:out.verification.stages[1].verification.report,stages:out.verification.stages.map(s=>s.status)}));
 assert.ok(['applied','warning'].includes(out.verification.status), out.verification.status + ': ' + out.verification.checks.map(c=>c.code).join(', '));
 assert.equal(out.verification.bodyPending,false);assert.equal(out.verification.stages[0].inputSha256,sourceHash);assert.equal(out.verification.stages[1].inputSha256,hash(aBytes));
 const final=new Uint8Array(await out.file.arrayBuffer());assert.equal(hash(final),out.sha256);
 assert.deepEqual(readMuPdfTablePages(final,mupdf)[0].rules,readMuPdfTablePages(aBytes,mupdf)[0].rules);
 const before=inspect(aBytes),after=inspect(final);assert.equal(after.length,1);
 const beforeTable=before[0].filter(x=>x.box[1]<100),afterTable=after[0].filter(x=>x.box[1]<100);
 assert.deepEqual(afterTable.map(x=>x.text),beforeTable.map(x=>x.text));
 for(let i=0;i<beforeTable.length;i++)for(let j=0;j<4;j++)assert.ok(Math.abs(afterTable[i].box[j]-beforeTable[i].box[j])<1e-4);
 assert.deepEqual(afterTable.find(x=>x.text==='11').box,beforeTable.find(x=>x.text==='11').box);
 assert.equal(tableRasterHash(final),tableRasterHash(aBytes));
 assert.match(after[0].map(x=>x.text).join(' '),/Changed body paragraph stays lower on the page\./);

 }finally{globalThis.fetch=saved;}
});

test('continuation retains furniture without repeating source table cells',{timeout:120000},async()=>{
 const bytes=fixture({furniture:true}),sourceHash=hash(bytes),tables=await inspectTables({bytes:bytes.buffer.slice(0),fileHash:sourceHash,revision:'test',pageIndex:0});
 const cell=tables.cells.find(c=>c.row===1&&c.col===1&&c.selection.status==='ready');assert.ok(cell);
 const edit={id:'cell',segmentId:'table:0:cell',pageIndex:0,before:cell.selection.before,after:'11',anchor:cell.selection.anchor};
 const body={id:'body',segmentId:'paragraph:0:body',pageIndex:0,before:'Original body paragraph stays lower on the page.',after:'Changed body paragraph stays lower on the page. '.repeat(30).trim(),anchor:{bbox:[40,190,300,210]}};
 const saved=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);if(u.protocol==='file:'){const {readFileSync}=await import('node:fs');return new Response(readFileSync(u));}return saved(input);};
 try {
   let stageA;const selection={prepare:async r=>{const v=await selectionPdf.prepare(r);stageA=new Uint8Array(await v.file.arrayBuffer());return v;}};
   const out=await prepare({file:new File([bytes],'fixture.pdf'),fileHash:sourceHash,edits:[edit,body]},{selectionPdf:selection,paragraphPdf});
   assert.ok(['applied','warning'].includes(out.verification.status),JSON.stringify(out.verification.checks));
   const final=new Uint8Array(await out.file.arrayBuffer());
   assert.deepEqual(readMuPdfTablePages(final,mupdf)[0].rules,readMuPdfTablePages(stageA,mupdf)[0].rules);
   assert.equal(tableRasterHash(final),tableRasterHash(stageA));
   const pages=inspect(final);assert.ok(pages.length>1);
   for(const page of pages.slice(1)) {const text=page.map(x=>x.text).join(' ');assert.match(text,/Running header/);assert.doesNotMatch(text,/Group|Value|Control|Treated/);}
   assert.match(pages[1].map(x=>x.text).join(' '),/1\.1/);
 } finally {globalThis.fetch=saved;}
});






