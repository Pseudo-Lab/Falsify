import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {inspectLayoutQuality} from '../src/paper-layout-quality.mjs';

test('sparse evidence separates source, final and artwork context from review candidates',()=>{
  const make=(denseFirst=false)=>{
    const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
    const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);const image=new mupdf.Image(pix),im=d.addImage(image);
    const line=(text,y)=>`BT /F 10 Tf 20 ${y} Td (${text}) Tj ET\n`;
    for(let i=0;i<4;i++) {
      let stream=i===2?'q 100 0 0 100 40 100 cm /Im Do Q\n':line('A short passage.',340);
      if(i===0 && denseFirst) for(let j=0;j<24;j++) stream+=line('A substantial line of continuous body text for measurement.',320-j*12);
      d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));
    }
    const b=d.saveToBuffer(),bytes=b.asUint8Array().slice();b.destroy();image.destroy();pix.destroy();d.destroy();return bytes;
  };
  const bytes=make(),source=make(true);
  const r=inspectLayoutQuality({bytes,mupdf,sourceBytes:source,sourcePageIndexes:[0,1,2,3]});
  assert.deepEqual(r.sparsePageEvidence.pages.map(p=>p.classification),['candidate','source-equally-sparse','artwork-only','document-final']);
  assert.equal(r.score,null);assert.ok(!r.issues.some(i=>i.type.includes('sparse')));
  const noSource=inspectLayoutQuality({bytes,mupdf});
  assert.equal(noSource.sparsePageEvidence.pages[0].classification,'source-context-unavailable');
});
