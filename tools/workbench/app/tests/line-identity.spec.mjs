import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {readOutputGlyphs} from '../src/paper-output-glyphs.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
function pdf(first, second, explicit=false, superscript=false) {
  const d=new mupdf.PDFDocument(), font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const space=explicit?' ':'', prefix=superscript?'(word) Tj /f 7 Tf (108-) Tj':`(${first}${space}) Tj`;
  const program=`BT /f 12 Tf 30 300 Td ${prefix} 0 -14 Td /f 12 Tf (${second}) Tj ET`;
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{f:font}},program));
  const b=d.saveToBuffer(), bytes=b.asUint8Array().slice(); b.destroy(); d.destroy(); return bytes;
}
const run=(bytes,text,reader=mupdf)=>checkRecomposition({bytes,expectedBlocks:[{id:'x',text}],pdfjs,mupdf:reader});
test('actual encoded line endings preserve punctuation, superscripts and explicit spaces',async()=>{
  for(const [first,second] of [['poly(A)-','enrichment'],['value-','12']]) {
    const joined=pdf(first,second), spaced=pdf(first,second,true);
    const sourceMap=readOutputGlyphs({bytes:joined,mupdf})[0].map(g=>g.scalar);
    const outputMap=readOutputGlyphs({bytes:spaced,mupdf})[0].map(g=>g.scalar);
    assert.deepEqual(outputMap, [...sourceMap.slice(0,first.length),32,...sourceMap.slice(first.length)]);
    assert.equal((await run(joined,first+second)).checks.content.status,'pass');
    assert.equal((await run(joined,first+' '+second)).checks.content.status,'finding');
    assert.equal((await run(spaced,first+' '+second)).checks.content.status,'pass');
    assert.equal((await run(spaced,first+second)).checks.content.status,'finding');
    assert.equal((await run(joined,first+second,{})).checks.content.status,'unavailable');
  }
  const bytes=pdf('', '110',false,true);
  assert.equal((await run(bytes,'word108-110')).checks.content.status,'pass');
  for(const wrong of ['word108- 110','word108-111','word110-108','word108110']) assert.equal((await run(bytes,wrong)).checks.content.status,'finding');
  const hyphen=pdf('re-','sign'); assert.equal((await run(hyphen,'resign')).checks.content.status,'finding');
});
test('ordinary spaces and ordered content remain mandatory',async()=>{
  const bytes=pdf('alpha beta-','gamma');
  for(const wrong of ['alphabeta-gamma','alpha  beta-gam ma','beta alpha-gamma','alpha beta-gamm9']) assert.equal((await run(bytes,wrong)).checks.content.status,'finding');
  assert.equal((await run(bytes,'alpha beta-gamma')).checks.content.status,'pass');
});
