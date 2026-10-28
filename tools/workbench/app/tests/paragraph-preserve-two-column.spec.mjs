import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
const app=resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'falsify-preserve-'));
mkdirSync(join(temp,'paragraph-vendor'));
for(const f of ['editcore.js','editcore.wasm'])copyFileSync(join(app,'src/paragraph-vendor/runtime',f),join(temp,'paragraph-vendor',f));
copyFileSync(join(app,'dist/paragraph-vendor/package.json'),join(temp,'paragraph-vendor/package.json'));
const plugin={name:'adapt',setup(b){b.onResolve({filter:/^\.\/browser-pdf-vendor\/mupdf\.js$/},()=>({path:pathToFileURL(join(app,'dist/browser-pdf-vendor/mupdf.js')).href,external:true}));b.onResolve({filter:/^node:crypto$/},()=>({path:join(app,'src/paragraph-pdf-crypto.mjs')}));b.onResolve({filter:/^\.\/runtime\.mjs$/},a=>a.importer.replaceAll('\\','/').endsWith('paragraph-vendor/editor.mjs')?({path:join(app,'src/paragraph-pdf-runtime.mjs')}):undefined);b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:join(app,'src/paragraph-pdf-engine-loader.mjs')}));b.onResolve({filter:/freetext-script$/},()=>({path:join(app,'src/paragraph-vendor/utils/freetext-script.ts')}));}};
await build({entryPoints:[join(app,'src/paragraph-pdf.mjs')],outfile:join(temp,'candidate.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[plugin]});
const {prepare}=await import(pathToFileURL(join(temp,'candidate.mjs')).href);
function fixture(){const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));const resources={Font:{F1:font}};
 const c='BT /F1 11 Tf 1 0 0 1 40 700 Tm (First line of a short example.) Tj 1 0 0 1 40 686 Tm (Second line has removable words and ends.) Tj ET\nBT /F1 11 Tf 330 700 Td (Right column is independent and stays untouched.) Tj ET';
 d.insertPage(-1,d.addPage([0,0,600,800],0,resources,c)); d.insertPage(-1,d.addPage([0,0,600,800],0,resources,'BT /F1 11 Tf 40 700 Td (Second page remains unchanged.) Tj ET'));
 const page=d.findPage(0),annots=d.newArray();annots.push(d.addObject({Type:'Annot',Subtype:'Link',Rect:[330,690,450,705],Border:[0,0,0],A:{S:'URI',URI:d.newString('https://example.invalid/unchanged')}}));page.put('Annots',annots);
 const b=d.saveToBuffer().asUint8Array().slice();d.destroy();return b;}
function pixels(bytes,page,onlyRight=false){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(page),pix=p.toPixmap([1,0,0,1,0,0],mupdf.ColorSpace.DeviceRGB,false),raw=pix.getPixels(),stride=pix.getStride(),a=[];for(let y=0;y<800;y++)a.push(...raw.slice(y*stride+(onlyRight?330:0)*3,y*stride+600*3));pix.destroy();p.destroy();d.destroy();return a;}
function text(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(0),s=p.toStructuredText(),out=s.asText().replace(/\s+/g,' ');s.destroy();p.destroy();d.destroy();return out;}
function link(bytes){const d=new mupdf.PDFDocument(bytes);try{const a=d.findPage(0).get('Annots',0);return {uri:a.get('A','URI').asString(),rect:Array.from({length:4},(_,i)=>a.get('Rect',i).asNumber())};}finally{d.destroy();}}
test('shrinking a multiline selection preserves the adjacent column and other page',async()=>{const previous=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);assert.equal(u.protocol,'file:');assert.ok(u.pathname.includes('/paragraph-vendor/'));return new Response(readFileSync(u));};try{
 const src=fixture(),original=src.slice(),before='First line of a short example.\nSecond line has removable words and ends.',after='First line of a short example.\nSecond line has words and ends.';
 const out=await prepare({file:src,edits:[{id:'shrink',pageIndex:0,before,after}]}),saved=new Uint8Array(await out.file.arrayBuffer());
 assert.deepEqual(src,original);assert.equal(out.verification.pageCount.output,2);assert.equal(out.verification.report.pages[0].paragraphs[0].lineRetention?.status,"source_line_deletion");assert.ok(text(saved).includes(after.replace(/\s+/g,' ')));assert.ok(text(saved).includes('Right column is independent and stays untouched.'));assert.deepEqual(pixels(saved,0,true),pixels(src,0,true));assert.deepEqual(pixels(saved,1),pixels(src,1));assert.deepEqual(link(saved),link(src));
 }finally{globalThis.fetch=previous;assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep));rmSync(temp,{recursive:true,force:true});}});

