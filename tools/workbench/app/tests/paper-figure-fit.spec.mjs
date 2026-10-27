import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {composeDocument} from '../src/paper-compose.mjs';
import {createTypstCompile} from '../src/paper-typst.mjs';
import {resolveOutputAssetSpans} from '../src/paper-asset-spans.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const root=process.env.FALSIFY_TYPST_MODULES, wasm=process.env.FALSIFY_TYPST_WASM, font=process.env.FALSIFY_TYPST_FONT;
const sourceBytes=new TextEncoder().encode('source'), hash=createHash('sha256').update(sourceBytes).digest('hex');
const block=(id,text)=>({id,text,styleId:'body',source:{pageIndex:0,range:{start:0,end:text.length},lines:[]}});
async function run(caption, baseline=false) {
 const {createTypstCompiler,createTypstFontBuilder}=await import(pathToFileURL(join(root,'@myriaddreamin/typst.ts/dist/esm/compiler.mjs')));
 const {loadFonts}=await import(pathToFileURL(join(root,'@myriaddreamin/typst.ts/dist/esm/options.init.mjs')));
 const fontBytes=await readFile(font), wasmBytes=await readFile(wasm);
 const compile=createTypstCompile({createTypstCompiler,createTypstFontBuilder,loadFonts,getModule:()=>wasmBytes});
 const box=[0,0,300,400], assetSource={pageIndex:0,bbox:box};
 const document={schema:'falsify.paper-document.v1',sourceSha256:hash,pages:[{width:400,height:600}],styles:[{id:'body',size:10,fontName:'Noto Serif'}],blocks:[block('body','Body text. '.repeat(16)),block('cap',caption),block('later','Later text. '.repeat(16))],assets:[{id:'pic',source:assetSource}]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:hash,items:[{kind:'paragraph',columns:2,blockIds:['body']},{id:'fig',kind:'asset',span:'page',assetIds:['pic'],blockIds:[],captionIds:['cap'],source:assetSource},{kind:'caption',blockIds:['cap']},{kind:'paragraph',columns:2,blockIds:['later']}]};
 const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,30,40],false);pix.clear(128);const png=pix.asPNG().slice();pix.destroy();
 let compiled;
 const out=await composeDocument({document,flow,sourceBytes,edits:[{blockId:'cap',pageIndex:0,start:7,end:13,before:'legend',after:'legend revised without truncation'}],assets:[{id:'pic',source:assetSource,content:{representation:'png',bytes:png}}],layoutMode:'measured-continuous'},{fonts:{family:'Noto Serif',candidates:[{family:'Noto Serif',getBytes:()=>fontBytes}]},compile:async p=>(compiled=await compile(baseline ? {...p,source:p.source.replace(/let paper-fit-width = if remaining >= .*?; \[/, "let paper-fit-width = 300pt; [")} : p))});
 const bytes=new Uint8Array(await out.file.arrayBuffer()), pdf=mupdf.Document.openDocument(bytes,'application/pdf');
 let text='', sizes=[]; for(let i=0;i<pdf.countPages();i++){const page=pdf.loadPage(i), structured=page.toStructuredText();text+=structured.asText();structured.walk({onChar(t,origin,font,size){sizes.push(size);},onImageBlock(b,t,image){image.destroy();}});structured.destroy();page.destroy();}
 const count=pdf.countPages();pdf.destroy();
 return {text,count,compiled,sizes,spans:resolveOutputAssetSpans({bytes,mupdf,flow,blockSpans:compiled.blockSpans})};
}
test('fitting a caption uses proportional image geometry and retains its complete text', {skip:!(root&&wasm&&font)},async()=>{
 const caption='Figure legend: '+('measurement illustrates a reproducible result. '.repeat(16))+'ENDCAPTION';
 const result=await run(caption), baseline=await run(caption,true);
 assert.ok(result.text.replace(/\s+/g,' ').includes(caption.replace('legend','legend revised without truncation'))); assert.ok(result.sizes.length && result.sizes.every(size=>Math.abs(size-10)<0.1));
 assert.equal(result.spans.spans.length,1); const [x,y,x2,y2]=result.spans.spans[0].bbox;
 assert.ok(Math.abs((x2-x)/(y2-y)-0.75)<0.01); assert.ok(x2-x<300 && x2-x>=150);
 assert.equal(result.count,2); assert.ok(baseline.count>result.count);
 const image=result.compiled.blockSpans.find(s=>s.id==='pic'), cap=result.compiled.blockSpans.find(s=>s.id==='cap');
 assert.equal(image.start.page,cap.start.page); assert.equal(cap.start.page,cap.end.page);
});
test('oversized caption remains complete and breakable', {skip:!(root&&wasm&&font)},async()=>{
 const caption='Figure legend: '+('reproducible observations remain in the caption. '.repeat(400))+'ENDCAPTION';
 const result=await run(caption); assert.ok(result.count>1);assert.ok(result.text.replace(/\s+/g,' ').includes(caption.replace('legend','legend revised without truncation'))); assert.ok(result.sizes.length && result.sizes.every(size=>Math.abs(size-10)<0.1)); assert.equal(result.spans.spans.length,1); const [x,y,x2,y2]=result.spans.spans[0].bbox; assert.ok(Math.abs(x2-x-300)<0.1 && Math.abs(y2-y-400)<0.1);
});

