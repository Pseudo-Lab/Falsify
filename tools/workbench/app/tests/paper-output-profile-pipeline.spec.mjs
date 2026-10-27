import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {prepare} from '../src/paper-recompose.mjs';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href;
function pdf(text,size) {
 const doc=new mupdf.PDFDocument();
 try {
  const font=doc.addSimpleFont(new mupdf.Font('Helvetica'));
  doc.insertPage(-1,doc.addPage([0,0,400,500],0,{Font:{f:font}},`BT /f ${size} Tf 40 400 Td (${text}) Tj ET`));
  const buffer=doc.saveToBuffer();try{return buffer.asUint8Array().slice();}finally{buffer.destroy();}
 }finally{doc.destroy();}
}
test('prepare observes edited output body size instead of checking source coordinates',async()=>{
 const before='Observed result remains unchanged.',after='Observed result now differs.';
 const original=pdf(before,12),snapshot=original.slice();
 const out=await prepare({file:original,edits:[{id:'change',pageIndex:0,before,after}]},{mupdf,pdfjs,compile:async()=>pdf(after,6)});
 assert.deepEqual(original,snapshot);
 assert.equal(out.verification.outputTextCheck,'pass');
 const report=out.verification.checkReport;
 assert.equal(report.layoutQuality.coverage.profile.bodyLines.checked,1);
 assert.equal(report.outputProfileEvidence.body[0].status,'observed');
 assert.ok(report.layoutQuality.issues.some(issue=>issue.type==='small-body-text'));
 assert.ok(out.file.size>0);
});
test('matching output body size produces no shrinking finding',async()=>{
 const text='Observed result remains unchanged.',original=pdf(text,12);
 const out=await prepare({file:original,edits:[]},{mupdf,pdfjs,compile:async()=>pdf(text,12)});
 assert.equal(out.verification.checkReport.layoutQuality.coverage.profile.bodyLines.checked,1);
 assert.ok(!out.verification.checkReport.layoutQuality.issues.some(issue=>issue.type==='small-body-text'));
});
