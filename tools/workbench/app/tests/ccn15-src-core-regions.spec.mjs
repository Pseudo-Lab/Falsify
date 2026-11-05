import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {prepareReconstruction} from '../src/pdf-latex-baseline.mjs';
import {enrichReconstructionRegions} from '../src/pdf-latex-regions.mjs';

test('region enrichment observes cancellation during asynchronous source inspection',async()=>{
  const pdf=new mupdf.PDFDocument();
  let bytes;
  try {
    pdf.insertPage(-1,pdf.addPage([0,0,200,200],0,{},''));
    const buffer=pdf.saveToBuffer();
    try {bytes=buffer.asUint8Array().slice();} finally {buffer.destroy();}
  } finally {pdf.destroy();}
  const {model}=await prepareReconstruction({file:{name:'synthetic.pdf',arrayBuffer:async()=>bytes}});
  const controller=new AbortController();
  const pending=enrichReconstructionRegions({model,bytes,mupdf,revision:'test',signal:controller.signal});
  queueMicrotask(()=>controller.abort());
  await assert.rejects(pending,{name:'AbortError'});
});
