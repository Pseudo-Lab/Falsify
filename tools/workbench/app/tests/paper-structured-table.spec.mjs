import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as mupdf from 'mupdf';
import {prepare} from '../src/paper-recompose.mjs';
import {createTypstCompile} from '../src/paper-typst.mjs';
import {createTypstCompiler,createTypstFontBuilder,loadFonts} from '../dist/recomposition-typst.mjs';

function fixture() {
 const d=new mupdf.PDFDocument(), font=new mupdf.Font('Helvetica'), f=d.addSimpleFont(font);
 const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,8,8],false);pix.clear(128);const image=new mupdf.Image(pix), im=d.addImage(image);
 let content='0 0 0 RG .5 w\n';for(const x of [40,160,280])content+=`${x} 420 m ${x} 480 l S\n`;for(const y of [420,440,460,480])content+=`40 ${y} m 280 ${y} l S\n`;
 for(const [r,row] of [['Group','Value'],['Control','10'],['Treated','10']].entries()) for(const [c,text] of row.entries())content+=`BT /F 8 Tf ${c?170:50} ${467-r*20} Td (${text}) Tj ET\n`;
 content+='BT /F 10 Tf 40 300 Td (Original body paragraph stays lower on the page.) Tj ET\nq 50 0 0 50 40 180 cm /Im Do Q\n';
 d.insertPage(0,d.addPage([0,0,400,500],0,{Font:{F:f},XObject:{Im:im}},content));const buffer=d.saveToBuffer(), bytes=Uint8Array.from(buffer.asUint8Array());buffer.destroy();image.destroy();pix.destroy();font.destroy();d.destroy();return bytes;
}
const hash=b=>createHash('sha256').update(b).digest('hex');
test('native ruled table remains two columns in actual Typst PDF with edited cell, body and figure',async()=>{
 const bytes=fixture(), wasm=readFileSync(new URL('../dist/recomposition-vendor/typst_ts_web_compiler_bg.wasm',import.meta.url)),font=readFileSync(new URL('../dist/recomposition-vendor/NotoSerif-Regular.ttf',import.meta.url));
 const compile=createTypstCompile({createTypstCompiler,createTypstFontBuilder,loadFonts,getModule:()=>wasm});
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'); pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href; const out=await prepare({file:bytes,fileHash:hash(bytes),edits:[{id:'cell',segmentId:'table:0:cell',pageIndex:0,before:'10',after:'11',anchor:{bbox:[170,44,179,56]}}]},{mupdf,fonts:[{id:'noto',family:'Noto Serif',bytes:font}],compile,pdfjs});
 assert.equal(out.verification.outputTextCheck,'pass'); const doc=mupdf.Document.openDocument(new Uint8Array(await out.file.arrayBuffer()),'application/pdf');let chars=[],images=0,paths=0;
 try {for(let i=0;i<doc.countPages();i++){const page=doc.loadPage(i), st=page.toStructuredText("preserve-images");st.walk({onChar(c,origin){chars.push({c,x:origin[0],y:origin[1]});},onImageBlock(_b,_t,image){images++;image.destroy();}});st.destroy();const dev=new mupdf.Device({strokePath(){paths++;},fillPath(){paths++;}});page.run(dev,[1,0,0,1,0,0]);dev.close();dev.destroy();page.destroy();}}finally{doc.destroy();}
 const locate=s=>{const text=chars.map(x=>x.c).join(''),at=text.indexOf(s);assert.ok(at>=0,`missing ${s}`);return chars[at];};
 const a=locate('Group'),b=locate('Value'),c=locate('Control'),e=locate('11'),f=locate('Treated'),g=locate('10');
 assert.ok(b.x>a.x+30 && Math.abs(a.y-b.y)<2);assert.ok(e.x>c.x+30 && Math.abs(c.y-e.y)<2);assert.ok(g.x>f.x+30 && Math.abs(f.y-g.y)<2);assert.ok(a.y<c.y && c.y<f.y);assert.ok(paths>=4);assert.ok(images>=1);locate('Original body paragraph');
});


test('ambiguous cell ownership keeps the existing flow intact',async()=>{
 const {readDocument}=await import('../src/paper-document.mjs'),{buildPaperFlow}=await import('../src/paper-flow.mjs'),{detectSourceTables}=await import('../src/table-adapter.mjs'),{attachStructuredTables}=await import('../src/paper-recompose.mjs');
 const bytes=fixture(),document=await readDocument({file:bytes}),flow=buildPaperFlow(document),model=await detectSourceTables({sourceBytes:bytes,sourceSha256:hash(bytes),revision:'test',mupdf});
 const bad=structuredClone(model.tables);bad[0].cells[0].bbox=[0,0,1,1];const before=structuredClone(flow);attachStructuredTables(document,flow,bad);assert.deepEqual(flow,before);
});


