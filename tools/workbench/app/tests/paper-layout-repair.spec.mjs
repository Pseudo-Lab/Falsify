import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {readFileSync} from 'node:fs';
import * as mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {prepare} from '../src/paper-recompose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href;
const fonts=[{id:'regular',family:'Liberation Serif',bytes:readFileSync(new URL('../dist/font-assets/LiberationSerif-Regular.ttf',import.meta.url))}];
function pdf({single=false,missing=false,small=false}={}) {
 const d=new mupdf.PDFDocument();try {const buffer=new mupdf.Buffer(fonts[0].bytes), font=new mupdf.Font('regular',buffer);const f=d.addSimpleFont(font);font.destroy();buffer.destroy();
 const lines=[];
 for(const x of (single?[30]:[30,310])) for(let i=0;i<4;i++) lines.push([x,450-i*14,`${x===30?'Left':'Right'} body line ${i+1} has useful text and evidence.`]);
 const stream=lines.filter((_,i)=>!missing || i!==1).map(([x,y,t])=>`BT /f ${small?6:12} Tf ${x} ${y} Td (${t}) Tj ET`).join('\n');
 d.insertPage(-1,d.addPage([0,0,600,600],0,{Font:{f}},stream)); const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
}
const options=compile=>({mupdf,pdfjs,fonts,compile});
test('repair checks each output and selects independently preserved content',async()=>{
 const source=pdf(), original=source.slice(), edits=[], copy=structuredClone(edits);let calls=0;
 const out=await prepare({file:source,edits,layoutMode:'measured-continuous'},options(async()=>++calls===1?pdf({missing:true}):pdf()));
 assert.equal(out.enginePlan.actual,'measured-continuous');assert.equal(calls,2);assert.equal(out.repair.selectedAttempt,2);assert.equal(out.repair.attempts[0].content,'finding');assert.equal(out.verification.outputTextCheck,'pass');assert.deepEqual(source,original);assert.deepEqual(edits,copy);
});
test('worse and unavailable retry retain the original; normal and fallback compile once',async()=>{
 for(const second of [pdf({missing:true}),new TextEncoder().encode('%PDF-1.7\ninvalid')]) {let calls=0;const out=await prepare({file:pdf(),edits:[],layoutMode:'measured-continuous'},options(async()=>++calls===1?pdf({missing:true}):second));assert.equal(calls,2);assert.equal(out.repair.selectedAttempt,1);}
 for(const source of [pdf(),pdf({single:true})]) {let calls=0;const out=await prepare({file:source,edits:[],layoutMode:'measured-continuous'},options(async()=>{calls++;return source;}));assert.equal(calls,1);assert.equal(out.repair.selectedAttempt,1);}
});
test('cancellation and invalid bindings never start an unrelated retry',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(prepare({file:pdf(),edits:[],layoutMode:'measured-continuous',signal:controller.signal},options(async()=>{calls++;controller.abort();return pdf({missing:true});})),{name:'AbortError'});assert.equal(calls,1);
 calls=0;await assert.rejects(prepare({file:pdf(),edits:[{pageIndex:0,before:'absent',after:'unchanged'}],layoutMode:'measured-continuous'},options(async()=>{calls++;return pdf();})),{code:'source-binding'});assert.equal(calls,0);
});

test('retry preserves the requested After and rejects geometry regression',async()=>{
 const source=pdf(), edits=[{pageIndex:0,before:'Left body line 1',after:'Left body line 1'}], original=structuredClone(edits);let calls=0;
 const out=await prepare({file:source,edits,layoutMode:'measured-continuous'},options(async ({source:typst})=>{assert.match(typst,/Left body line 1/);return ++calls===1?pdf({missing:true}):pdf({small:true});}));
 assert.equal(calls,2);assert.equal(out.repair.selectedAttempt,1);assert.deepEqual(edits,original);
});
