import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {prepare} from '../dist/blind-pdf.mjs';
const hex='46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';
const marker=`\nq\nBT\n1 0 0 1 30 17.8 Tm\n/helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<${hex}>]TJ\nET\nQ\n`;
const banner='\nq\n25 13 562 14 re\nh\n.98 .94 .87 rg f\nQ\n';
const body='BT /helv 12 Tf 30 700 Td (Publisher and body remain) Tj ET';
function fixture(kind='separate', pages=2) {
 const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
 for(let i=0;i<pages;i++) {
   d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{helv:font}},body));
   const p=d.findPage(i), prev=p.get('Contents');
   if(kind==='separate') p.put('Contents',[prev,d.addStream(banner,{}),d.addStream(marker,{})]);
   if(kind==='combined') p.put('Contents',d.addStream(body+'\n'+banner+marker,{}));
 }
 const b=d.saveToBuffer(), bytes=b.asUint8Array().slice(); b.destroy(); d.destroy(); return {name:'test.pdf',bytes};
}
function text(bytes,i=0){const d=new mupdf.PDFDocument(bytes);try{return d.loadPage(i).toStructuredText().asText();}finally{d.destroy();}}
test('repeated pages remove only separated marker and retain body and input',async()=>{
 const f=fixture(), source=f.bytes.slice(), out=await prepare({file:f});
 assert.equal(out.changed,true); assert.equal(out.removed.length,2); assert.equal(out.verification.renderOutsideFooter,true);
 assert.deepEqual(f.bytes,source); assert.match(text(f.bytes),/FALSIFY RED TEAM TRAINING COPY/);
 const outputBytes=new Uint8Array(await out.file.arrayBuffer());
 for(let i=0;i<2;i++){const t=text(outputBytes,i);assert.match(t,/Publisher and body remain/);assert.doesNotMatch(t,/FALSIFY RED TEAM/);}
});
test('combined content is refused without changing input',async()=>{const f=fixture('combined'), before=f.bytes.slice();await assert.rejects(prepare({file:f}),{code:'unsafe-marker-stream'});assert.deepEqual(f.bytes,before);});
test('unmarked document returns original bytes and hash',async()=>{const f=fixture('none'),out=await prepare({file:f});assert.equal(out.changed,false);assert.equal(out.file,f);assert.equal(out.removed.length,0);assert.equal(out.sha256,createHash('sha256').update(f.bytes).digest('hex'));});
test('aborted request fails',async()=>{const c=new AbortController();c.abort();await assert.rejects(prepare({file:fixture(),signal:c.signal}),{name:'AbortError'});});
test('native File bytes method is read through arrayBuffer',async()=>{const f=fixture();const out=await prepare({file:new File([f.bytes],'input.pdf',{type:'application/pdf'})});assert.equal(out.changed,true);assert.equal(out.removed.length,2);});
