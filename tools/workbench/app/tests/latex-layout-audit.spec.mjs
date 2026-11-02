import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {auditLatexLayout} from '../src/latex-layout-audit.mjs';

function fixture(defect=false) {
  const doc = new mupdf.PDFDocument(), font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const line = (text,x,y) => `BT /F 12 Tf ${x} ${y} Td (${text}) Tj ET\n`;
  let stream = line('Ordinary synthetic text',30,300);
  if (defect) stream += line('Overlapping synthetic text',65,300) + line('Outside',-10,240);
  doc.insertPage(-1,doc.addPage([0,0,300,400],0,{Font:{F:font}},stream));
  const buffer=doc.saveToBuffer(), bytes=buffer.asUint8Array().slice(); buffer.destroy();doc.destroy();return bytes;
}
test('real MuPDF geometry finds defects and binds results to unchanged bytes',async()=>{
  const bytes=fixture(true), original=bytes.slice();
  const result=await auditLatexLayout({bytes,mupdf});
  assert.equal(result.status,'partial');
  assert.ok(result.findings.some(x=>x.type==='ink-outside-page'));
  assert.ok(result.findings.some(x=>x.type==='text-overlap'));
  assert.deepEqual(bytes,original);
  assert.equal(result.outputPdfHash,createHash('sha256').update(original).digest('hex'));
  assert.ok(result.findings.every(x=>Object.keys(x).sort().join(',')==='bbox,pageIndex,type' && x.pageIndex===0 && x.bbox.length===4));
});
test('ordinary PDF remains partial with measured coverage and private-free output',async()=>{
  const secret='private heading secret';
  const result=await auditLatexLayout({bytes:fixture(),mupdf,profile:{coordinateSpace:'output',headings:[{text:secret}],captions:[{text:secret}]}});
  assert.equal(result.schema,'falsify.latex-layout-audit.v1');assert.equal(result.status,'partial');
  assert.deepEqual(result.findings,[]);assert.equal(result.coverage.pages,1);assert.equal(result.coverage.textPaint,true);
  assert.equal(result.coverage.profile.headings.skipped,1);
  assert.ok(result.limitations.some(x=>x.includes('Heading could not')));
  assert.ok(!JSON.stringify(result).includes(secret));assert.ok(JSON.stringify(result).length<10000);
});
test('missing engine reports unavailable and preserves cancellation',async()=>{
  const bytes=fixture(), result=await auditLatexLayout({bytes});
  assert.equal(result.status,'unavailable');assert.equal(result.coverage,null);assert.deepEqual(result.findings,[]);
  assert.ok(result.limitations.includes('MuPDF unavailable.'));
  assert.equal(result.outputPdfHash,createHash('sha256').update(bytes).digest('hex'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(auditLatexLayout({bytes,mupdf,signal:controller.signal}),{name:'AbortError'});
});
test('inspection errors do not expose private error messages',async()=>{
  const secret='private error payload';
  const broken={Document:{openDocument(){throw new Error(secret);}},Device:class {}};
  const result=await auditLatexLayout({bytes:fixture(),mupdf:broken});
  assert.equal(result.status,'unavailable');
  assert.ok(result.limitations.includes('Layout inspection unavailable.'));
  assert.ok(!JSON.stringify(result).includes(secret));
});
