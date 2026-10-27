import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {buildOutputProfile} from '../src/paper-output-profile.mjs';
import {inspectLayoutQuality} from '../src/paper-layout-quality.mjs';

function pdf({duplicate=false,image=true,duplicateImage=false,font='Courier',size=6,subsetName}={}) {
 const d=new mupdf.PDFDocument(),f=d.addSimpleFont(new mupdf.Font(font)); const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);const im=new mupdf.Image(pix), ref=d.addImage(im);
 if(subsetName)f.put('BaseFont',d.newName(subsetName));
 const line=(t,y)=>`BT /F ${size} Tf 30 ${y} Td (${t}) Tj ET\n`;
 d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f}},line('Unrelated page',350)));
 let stream=(image?'q 100 0 0 80 80 200 cm /Im Do Q\n':'80 200 100 80 re f\n')+line('Figure 1. An image',185)+line('Scientific value p < 0.05 remains.',120);
 if(duplicateImage)stream+='q 100 0 0 80 80 200 cm /Im Do Q\n';
 if(duplicate)stream+=line('Scientific value p < 0.05 remains.',90);
 d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f},XObject:{Im:ref}},stream)); const buffer=d.saveToBuffer(),bytes=buffer.asUint8Array().slice();buffer.destroy();im.destroy();pix.destroy();d.destroy();return bytes;
}
const document={pages:[{width:300}],styles:[{id:'s',size:12}],blocks:[{id:'p',text:'Scientific value p < 0.05 remains.',source:{pageIndex:0,characters:[{start:0,end:35,styleId:'s'}]}},{id:'c',text:'Figure 1. An image',source:{pageIndex:0}}]};
const flow={items:[{kind:'paragraph',blockIds:['p']},{kind:'asset',assetIds:['im'],captionIds:['c'],source:{pageIndex:0,bbox:[1,2,3,4]}},{kind:'caption',blockIds:['c']}]};
const expectedBlocks=document.blocks.map(({id,text})=>({id,text}));
const run=(options={},extra={})=>buildOutputProfile({bytes:pdf(options),mupdf,document,flow,expectedBlocks,selectedFamilyAliases:['Helvetica'],assetSpans:[{id:'im',pageIndex:1,bbox:[80,120,180,200]}],...extra});
test('output observations bind source blocks and use output page and image geometry',()=>{const {profile,evidence}=run();assert.equal(evidence.body[0].pageIndex,1);assert.deepEqual(profile.captions[0].assetBbox,[80,120,180,200]);assert.equal(profile.captions[0].assetPageIndex,1);const q=inspectLayoutQuality({bytes:pdf(),mupdf,profile});assert.equal(q.coverage.profile.bodyLines.checked,1);assert.equal(q.coverage.profile.captions.checked,1);assert.ok(q.issues.some(x=>x.type==='small-body-text'));assert.ok(q.issues.some(x=>x.type==='body-font-deviation'));});
test('missing or ambiguous source and output are skipped',()=>{assert.equal(run({duplicate:true}).profile.bodyLines.length,0);assert.equal(run({}, {expectedBlocks:[]}).profile.bodyLines.length,0);assert.equal(run({}, {document:{...document,blocks:[]}}).profile.bodyLines.length,0);assert.equal(run({}, {expectedBlocks:[...expectedBlocks,expectedBlocks[0]]}).profile.bodyLines.length,0);});
test('vector paint and source coordinates cannot establish image ownership',()=>{const a=run({image:false});assert.equal(a.profile.captions.length,0);assert.match(a.evidence.captions[0].reason,/vector/);assert.equal(run({}, {assetSpans:[{id:'im',pageIndex:0,bbox:[1,2,3,4]}]}).profile.captions.length,0);});
test('unverified font aliases are not inferred from observed output',()=>{const r=run({}, {selectedFamilyAliases:undefined});assert.equal(r.profile.outputBodyFontNames,undefined);assert.equal(r.evidence.font.status,'unavailable');});
test('repeated expected source text cannot bind a single output occurrence',()=>{const extra={id:'other',text:expectedBlocks[0].text};assert.equal(run({}, {expectedBlocks:[...expectedBlocks,extra]}).profile.bodyLines.length,0);});
test('captions over twenty output lines are explicitly unavailable',()=>{const d=new mupdf.PDFDocument(),f=d.addSimpleFont(new mupdf.Font('Helvetica'));const lines=Array.from({length:21},(_,i)=>`part${i}`);const stream=lines.map((t,i)=>`BT /F 8 Tf 30 ${380-i*12} Td (${t}) Tj ET`).join('\n');d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:f}},stream));const b=d.saveToBuffer(),bytes=b.asUint8Array().slice();b.destroy();d.destroy();const r=buildOutputProfile({bytes,mupdf,document,flow,expectedBlocks:[expectedBlocks[0],{id:'c',text:lines.join(' ')}]});assert.match(r.evidence.captions[0].reason,/20-line/);assert.equal(r.profile.captions.length,0);});
import {readFileSync} from 'node:fs';
test('selected font aliases come from selected font bytes name table',()=>{const bytes=new Uint8Array(readFileSync(new URL('../dist/font-assets/LiberationSerif-Regular.ttf',import.meta.url)));const r=run({}, {selectedFamilyAliases:undefined,fontPlan:{selected:{family:'misleading',getBytes:()=>bytes}}});assert.ok(r.profile.outputBodyFontNames.includes('Liberation Serif'));assert.ok(r.profile.outputBodyFontNames.includes('LiberationSerif'));assert.ok(!r.profile.outputBodyFontNames.includes('misleading'));});

test('fallback font names come from used candidate bytes when no font covers the whole paper',()=>{
 const bytes=new Uint8Array(readFileSync(new URL('../dist/font-assets/LiberationSerif-Regular.ttf',import.meta.url)));
 const r=run({}, {selectedFamilyAliases:undefined,fontPlan:{selected:null,candidates:[{family:'Liberation Serif',getBytes:()=>bytes}],fallback:[{kind:'glyph',family:'Liberation Serif'}]}});
 assert.ok(r.profile.outputBodyFontNames.includes('LiberationSerif'));
});
test('a small source paragraph is checked against its own source size',()=>{
 const profile={coordinateSpace:'output',bodyFontSize:12,bodyLines:[{text:'Scientific value p < 0.05 remains.',sourceFontSize:6}]};
 const q=inspectLayoutQuality({bytes:pdf(),mupdf,profile});
 assert.equal(q.coverage.profile.bodyLines.checked,1);
 assert.ok(!q.issues.some(x=>x.type==='small-body-text'));
});
test('multiple resource aliases nominate one actual capture without hiding duplicate placements',()=>{
 const grouped={...flow,items:flow.items.map(item=>item.kind==='asset'?{...item,renderAssetId:'capture',assetIds:['im','panel']}:item)};
 const assetSpans=['capture','im','panel'].map(id=>({id,pageIndex:1,bbox:[80,120,180,200]}));
 assert.equal(run({}, {flow:grouped,assetSpans}).profile.captions.length,1);
 assert.equal(run({duplicateImage:true}, {flow:grouped,assetSpans}).profile.captions.length,0);
});
test('a PDF subset prefix preserves font identity while a different family still fails',()=>{
 const bytes=pdf({subsetName:'ABCDEF+Courier'}),profile={coordinateSpace:'output',bodyLines:[{text:'Scientific value p < 0.05 remains.'}],outputBodyFontNames:['Courier']};
 const correct=inspectLayoutQuality({bytes,mupdf,profile});
 assert.equal(correct.coverage.profile.fontNames.checked,1);
 assert.ok(!correct.issues.some(x=>x.type==='body-font-deviation'));
 const wrong=inspectLayoutQuality({bytes,mupdf,profile:{...profile,outputBodyFontNames:['Helvetica']}});
 assert.ok(wrong.issues.some(x=>x.type==='body-font-deviation'));
});
