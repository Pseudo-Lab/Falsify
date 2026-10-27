import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as mupdf from 'mupdf';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
function pdf(caption){
 const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
 const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);const image=new mupdf.Image(pix),im=d.addImage(image);
 const line=(t,x,y)=>`BT /F 10 Tf ${x} ${y} Td (${t}) Tj ET\n`;
 let stream='q 100 0 0 80 80 200 cm /Im Do Q\n'+line(caption,80,185)+line('First body.',30,120)+line('Second body.',30,100);
 d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));const b=d.saveToBuffer(),bytes=b.asUint8Array().slice();b.destroy();image.destroy();pix.destroy();d.destroy();return bytes;
}
test('floating caption with duplicate source block ID is unavailable',async()=>{
 const text='Figure one.';
 await assert.rejects(checkRecomposition({bytes:pdf(text),expectedBlocks:[{id:'a',text:'First body.'},{id:'cap',text},{id:'cap',text:'Second body.'}],pdfjs,mupdf,layoutProfile:{coordinateSpace:'output',captions:[{id:'cap',text,assetPageIndex:0,assetBbox:[80,120,180,200]}]},flowExpectations:{floatingCaptionBlockIds:['cap']}}), /unique expected blocks/);
});
test('truncated floating caption cannot satisfy exact content',async()=>{
 const full='word '.repeat(600).trim(), actual='word '.repeat(132).trim();
 const r=await checkRecomposition({bytes:pdf(actual),expectedBlocks:[{id:'a',text:'First body.'},{id:'cap',text:full},{id:'b',text:'Second body.'}],pdfjs,mupdf,layoutProfile:{coordinateSpace:'output',captions:[{id:'cap',text:full,assetPageIndex:0,assetBbox:[80,120,180,200]}]},flowExpectations:{floatingCaptionBlockIds:['cap']}});
 assert.equal(r.checks.flow.status,'unavailable');assert.equal(r.checks.content.status,'finding');
});
