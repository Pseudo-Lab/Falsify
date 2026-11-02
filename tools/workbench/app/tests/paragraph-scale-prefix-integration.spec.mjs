import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
const app=resolve(fileURLToPath(new URL('..',import.meta.url)));
const candidate=resolve(process.env.PARAGRAPH_CANDIDATE || join(app,'src/paragraph-pdf.mjs'));
const candidateApp=resolve(candidate,'../..');
const temp=mkdtempSync(join(tmpdir(),'falsify-scale-prefix-'));
mkdirSync(join(temp,'paragraph-vendor'));
for(const f of ['editcore.js','editcore.wasm']) copyFileSync(join(candidateApp,'src/paragraph-vendor/runtime',f),join(temp,'paragraph-vendor',f));
copyFileSync(join(app,'dist/paragraph-vendor/package.json'),join(temp,'paragraph-vendor/package.json'));
const plugin={name:'adapt',setup(b){b.onResolve({filter:/^\.\/browser-pdf-vendor\/mupdf\.js$/},()=>({path:pathToFileURL(join(app,'dist/browser-pdf-vendor/mupdf.js')).href,external:true}));b.onResolve({filter:/^node:crypto$/},()=>({path:join(app,'src/paragraph-pdf-crypto.mjs')}));b.onResolve({filter:/^\.\/runtime\.mjs$/},a=>a.importer.replaceAll('\\','/').endsWith('paragraph-vendor/editor.mjs')?({path:join(candidateApp,'src/paragraph-pdf-runtime.mjs')}):undefined);b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:join(app,'src/paragraph-pdf-engine-loader.mjs')}));b.onResolve({filter:/freetext-script$/},()=>({path:join(app,'src/paragraph-vendor/utils/freetext-script.ts')}));}};
await build({entryPoints:[candidate],outfile:join(temp,'candidate.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[plugin]});
const core=await build({entryPoints:[join(candidateApp,'src/paragraph-vendor/engine/core.js')],bundle:true,write:false,format:'esm',platform:'node',plugins:[plugin]});
const {PdfEngine}=await import('data:text/javascript;base64,'+Buffer.from(core.outputFiles[0].contents).toString('base64'));
const {default:create}=await import(pathToFileURL(join(temp,'paragraph-vendor/editcore.js')).href);
after(()=>{assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep));rmSync(temp,{recursive:true,force:true});});
const {prepare}=await import(pathToFileURL(join(temp,'candidate.mjs')).href);
function fixture(mask=true,variant='normal'){const d=new mupdf.PDFDocument(), font=d.addSimpleFont(new mupdf.Font('Helvetica'));if(variant==='widths'){font.put('FirstChar',32);font.put('LastChar',126);font.put('Widths',Array(95).fill(500));} if(variant==='differences')font.put('Encoding',{Type:'Encoding',BaseEncoding:'WinAnsiEncoding',Differences:[65,'A']});if(variant==='tounicode')font.put('ToUnicode',d.addStream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Identity def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 1 beginbfrange <00> <ff> <0000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end',{}));const resources={Font:{F1:font}};
 const c=`BT /F1 11 Tf 1.03 0 0 1 40 700 Tm (First line contains a concealed marker here.) Tj ET\n${mask?'q 1 1 1 rg 100 697 24 12 re f Q'+(mask==='two'?'\nq 1 1 1 rg 150 697 24 12 re f Q':''):''}\nBT /F1 11 Tf 1.002 0 0 1 40 686 Tm (Second line has words to replace at the end.) Tj 0.998 0 0 1 40 672 Tm (${variant==='delete'?'Final line removes every remaining word.':'Second line has words to replace at the end.'}) Tj ET\nBT /F1 11 Tf 330 700 Td (Right column is independent and stays untouched.) Tj ET`;
 d.insertPage(-1,d.addPage([0,0,600,800],0,resources,c));d.insertPage(-1,d.addPage([0,0,600,800],0,resources,'BT /F1 11 Tf 40 700 Td (Second page remains unchanged.) Tj ET'));const bytes=d.saveToBuffer().asUint8Array().slice();d.destroy();return bytes;}
function pixels(bytes,page,x0,y0,x1,y1){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(page),pix=p.toPixmap([1,0,0,1,0,0],mupdf.ColorSpace.DeviceRGB,false),raw=pix.getPixels(),stride=pix.getStride(),a=[];for(let y=y0;y<y1;y++)a.push(...raw.slice(y*stride+x0*3,y*stride+x1*3));pix.destroy();p.destroy();d.destroy();return a;}
function text(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(0),s=p.toStructuredText(),out=s.asText().replace(/\s+/g,' ');s.destroy();p.destroy();d.destroy();return out;}
function prefixGlyphs(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(0),s=p.toStructuredText('preserve-whitespace'),a=[];s.walk({onChar(ch,origin,font,size,quad){if(origin[1]>95 && origin[1]<105 && origin[0]<300) a.push({ch,origin:[...origin],font:font.getName(),size,quad:[...quad]});}});s.destroy();p.destroy();d.destroy();return a;}
test('scaled source prefix stays below an interleaved mask after long suffix reflow',async()=>{const previous=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);assert.equal(u.protocol,'file:');assert.ok(u.pathname.includes('/paragraph-vendor/'));return new Response(readFileSync(u));};try{
 const src=fixture(),original=src.slice(),before='First line contains a concealed marker here.\nSecond line has words to replace at the end.\nSecond line has words to replace at the end.',after='First line contains a concealed marker here. Second line has words to replace words to replace words to replace words to replace words to replace at the end.';
 assert.ok(prefixGlyphs(src).length>30,'prefix glyphs must be observable');
 assert.notDeepEqual(pixels(src,0,100,91,124,103),pixels(fixture(false),0,100,91,124,103),'mask must conceal source ink');
 const M=await create({wasmBinary:readFileSync(join(temp,'paragraph-vendor/editcore.wasm')),print(){},printErr(){}});const cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);const engine=new PdfEngine(M);engine.open(src);engine.loadPage(0);const model=engine.buildModel();assert.deepEqual(model[0].lines.map(l=>l.off),[0,45,90]);const handles=engine.paragraphObjects(model[0].id),objects=Array.from({length:M._FPDFPage_CountObjects(engine.page)},(_,i)=>M._FPDFPage_GetObject(engine.page,i)>>>0);assert.equal(handles.length,3);const first=objects.indexOf(handles[0]),second=objects.indexOf(handles[1]);assert.ok(first>=0 && second>first+1 && objects.slice(first+1,second).some(h=>M._FPDFPageObj_GetType(h)===2),'path must be interleaved between prefix and suffix');assert.ok(Math.abs(model[0].runs[1].hScale-model[0].runs[2].hScale)>0.003);engine.close();
 const out=await prepare({file:src,edits:[{id:'long',pageIndex:0,before,after}]}),saved=new Uint8Array(await out.file.arrayBuffer());
 assert.deepEqual(src,original);assert.equal(out.verification.pageCount.output,2);
 const retention=out.verification.report.pages[0].paragraphs[0].lineRetention;assert.equal(retention?.status,'reflowed');assert.ok(retention.prefixKept>=1);assert.equal(retention.suffixReflow,true);
 assert.ok(text(saved).includes(after.replace(/\s+/g,' ')));assert.ok(text(saved).includes('Right column is independent and stays untouched.'));
 const oldGlyphs=prefixGlyphs(src),newGlyphs=prefixGlyphs(saved);assert.equal(newGlyphs.length,oldGlyphs.length);oldGlyphs.forEach((g,i)=>{const n=newGlyphs[i];assert.equal(n.ch,g.ch);assert.equal(n.font,g.font);assert.ok(Math.abs(n.size-g.size)<0.001);for(const k of ['origin','quad']) g[k].forEach((v,j)=>assert.ok(Math.abs(v-n[k][j])<0.001,`prefix ${i} ${k}[${j}]`));});
 assert.ok(pixels(saved,0,40,105,300,180).some(v=>v<128),'replacement must paint visible ink');
 assert.deepEqual(pixels(saved,0,40,88,300,104),pixels(src,0,40,88,300,104));
 assert.deepEqual(pixels(saved,0,330,0,600,800),pixels(src,0,330,0,600,800));assert.deepEqual(pixels(saved,1,0,0,600,800),pixels(src,1,0,0,600,800));
 const again=await prepare({file:saved,edits:[{id:'again',pageIndex:0,before:'Second line has',after:'Second line'}]}),savedAgain=new Uint8Array(await again.file.arrayBuffer());assert.ok(text(savedAgain).includes('Second line words to replace'));assert.deepEqual(pixels(savedAgain,0,40,88,300,104),pixels(src,0,40,88,300,104));assert.deepEqual(pixels(savedAgain,1,0,0,600,800),pixels(src,1,0,0,600,800));
 }finally{globalThis.fetch=previous;}});





function suffixFonts(bytes){const d=mupdf.Document.openDocument(bytes,'application/pdf'),p=d.loadPage(0),s=p.toStructuredText(),a=[];s.walk({onChar(ch,origin,font){if(ch.trim() && origin[0]<300 && origin[1]>105) a.push(font.getName());}});s.destroy();p.destroy();d.destroy();return a;}
test('new words use the source font in a scaled prefix reflow',async()=>{const previous=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);assert.equal(u.protocol,'file:');assert.ok(u.pathname.includes('/paragraph-vendor/'));return new Response(readFileSync(u));};try{
 const src=fixture(),original=src.slice(),before='First line contains a concealed marker here.\nSecond line has words to replace at the end.\nSecond line has words to replace at the end.',after='First line contains a concealed marker here. Second line has a substantially longer replacement with several additional words to force the text to wrap across multiple lines.';
 assert.ok(prefixGlyphs(src).length>30,'prefix glyphs must be observable');
 assert.notDeepEqual(pixels(src,0,100,91,124,103),pixels(fixture(false),0,100,91,124,103),'mask must conceal source ink');
 const M=await create({wasmBinary:readFileSync(join(temp,'paragraph-vendor/editcore.wasm')),print(){},printErr(){}});const cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);const engine=new PdfEngine(M);engine.open(src);engine.loadPage(0);const model=engine.buildModel();assert.deepEqual(model[0].lines.map(l=>l.off),[0,45,90]);const handles=engine.paragraphObjects(model[0].id),objects=Array.from({length:M._FPDFPage_CountObjects(engine.page)},(_,i)=>M._FPDFPage_GetObject(engine.page,i)>>>0);assert.equal(handles.length,3);const first=objects.indexOf(handles[0]),second=objects.indexOf(handles[1]);assert.ok(first>=0 && second>first+1 && objects.slice(first+1,second).some(h=>M._FPDFPageObj_GetType(h)===2),'path must be interleaved between prefix and suffix');assert.ok(Math.abs(model[0].runs[1].hScale-model[0].runs[2].hScale)>0.003);engine.close();
 const out=await prepare({file:src,edits:[{id:'long',pageIndex:0,before,after}]}),saved=new Uint8Array(await out.file.arrayBuffer());
 assert.deepEqual(src,original);assert.equal(out.verification.pageCount.output,2);
 const retention=out.verification.report.pages[0].paragraphs[0].lineRetention;assert.equal(retention?.status,'reflowed');assert.ok(retention.prefixKept>=1);assert.equal(retention.suffixReflow,true);
 const fonts=suffixFonts(saved);assert.ok(fonts.length>40);assert.deepEqual([...new Set(fonts)],['Helvetica']);
 assert.ok(text(saved).includes(after.replace(/\s+/g,' ')));assert.ok(text(saved).includes('Right column is independent and stays untouched.'));
 const oldGlyphs=prefixGlyphs(src),newGlyphs=prefixGlyphs(saved);assert.equal(newGlyphs.length,oldGlyphs.length);oldGlyphs.forEach((g,i)=>{const n=newGlyphs[i];assert.equal(n.ch,g.ch);assert.equal(n.font,g.font);assert.ok(Math.abs(n.size-g.size)<0.001);for(const k of ['origin','quad']) g[k].forEach((v,j)=>assert.ok(Math.abs(v-n[k][j])<0.001,`prefix ${i} ${k}[${j}]`));});
 assert.ok(pixels(saved,0,40,105,300,180).some(v=>v<128),'replacement must paint visible ink');
 assert.deepEqual(pixels(saved,0,40,88,300,104),pixels(src,0,40,88,300,104));
 assert.deepEqual(pixels(saved,0,330,0,600,800),pixels(src,0,330,0,600,800));assert.deepEqual(pixels(saved,1,0,0,600,800),pixels(src,1,0,0,600,800));
 }finally{globalThis.fetch=previous;}});





for(const variant of ['widths','differences','unicode','tounicode']) test(`unsafe original-font reuse is refused for ${variant}`,async()=>{const previous=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(input);assert.equal(u.protocol,'file:');assert.ok(u.pathname.includes('/paragraph-vendor/'));return new Response(readFileSync(u));};try {const src=fixture(true,variant),original=src.slice(),before='First line contains a concealed marker here.\nSecond line has words to replace at the end.\nSecond line has words to replace at the end.',after=variant==='unicode'?'First line contains a concealed marker here. Second line has a café with several additional words to force the text to wrap across multiple lines.':'First line contains a concealed marker here. Second line has a substantially longer replacement with several additional words to force the text to wrap across multiple lines.';await assert.rejects(prepare({file:src,edits:[{id:'long',pageIndex:0,before,after}]}),e=>e.code==='COMMIT_FAILED' && e.details?.cause==='suffix_font_changed');assert.deepEqual(src,original);}finally{globalThis.fetch=previous;}});

test('two interleaved masks keep the prefix concealed after re-edit',async()=>{const previous=globalThis.fetch;globalThis.fetch=async input=>new Response(readFileSync(new URL(input)));try {
 const src=fixture('two'),before='First line contains a concealed marker here.\nSecond line has words to replace at the end.\nSecond line has words to replace at the end.',after='First line contains a concealed marker here. Second line has words to replace words to replace words to replace words to replace words to replace at the end.';
 for(const [x0,x1] of [[100,124],[150,174]]) assert.notDeepEqual(pixels(src,0,x0,91,x1,103),pixels(fixture(false),0,x0,91,x1,103));
 const first=await prepare({file:src,edits:[{id:'long',pageIndex:0,before,after}]}),saved=new Uint8Array(await first.file.arrayBuffer());
 assert.deepEqual(pixels(saved,0,40,88,300,104),pixels(src,0,40,88,300,104));
 const again=await prepare({file:saved,edits:[{id:'again',pageIndex:0,before:'Second line has',after:'Second line'}]}),savedAgain=new Uint8Array(await again.file.arrayBuffer());
 assert.ok(text(savedAgain).includes('Second line words to replace'));
 assert.deepEqual(pixels(savedAgain,0,40,88,300,104),pixels(src,0,40,88,300,104));
 assert.deepEqual(pixels(savedAgain,1,0,0,600,800),pixels(src,1,0,0,600,800));
 }finally{globalThis.fetch=previous;}});

for (const mask of [true, 'two']) test(`deleting the entire final suffix preserves ${mask === true ? 'one mask' : 'two masks'} and survives reopen`, async () => {
 const previous=globalThis.fetch; globalThis.fetch=async input=>new Response(readFileSync(new URL(input))); try {
  const src=fixture(mask,'delete'), original=src.slice();
  const before='Final line removes every remaining word.';
  const after='';
  const out=await prepare({file:src,edits:[{id:'delete-suffix',pageIndex:0,before,after}]}), saved=new Uint8Array(await out.file.arrayBuffer());
  assert.deepEqual(src,original); assert.equal(out.verification.pageCount.output,2);
  assert.equal(out.verification.report.pages[0].paragraphs[0].lineRetention.status,'source_suffix_deleted');
  assert.notEqual(out.verification.status,'failed',JSON.stringify(out.verification.checks));
  assert.ok(!text(saved).includes(before));
  assert.equal((text(saved).match(/Second line has words to replace at the end\./g)||[]).length,1);
  assert.deepEqual(pixels(saved,0,40,88,300,104),pixels(src,0,40,88,300,104));
  const oldGlyphs=prefixGlyphs(src),newGlyphs=prefixGlyphs(saved); assert.equal(newGlyphs.length,oldGlyphs.length); oldGlyphs.forEach((g,i)=>{const n=newGlyphs[i]; assert.equal(n.ch,g.ch); assert.equal(n.font,g.font); assert.ok(Math.abs(n.size-g.size)<0.001); for(const k of ['origin','quad']) g[k].forEach((v,j)=>assert.ok(Math.abs(v-n[k][j])<0.001));});
  const again=await prepare({file:saved,edits:[{id:'again',pageIndex:0,before:'Second line has',after:'Second line'}]}), savedAgain=new Uint8Array(await again.file.arrayBuffer());
  assert.notEqual(again.verification.status,'failed',JSON.stringify(again.verification.checks));
  assert.ok(text(savedAgain).includes('Second line words to replace'));
  assert.deepEqual(pixels(savedAgain,0,40,88,300,104),pixels(src,0,40,88,300,104));
  assert.deepEqual(pixels(savedAgain,1,0,0,600,800),pixels(src,1,0,0,600,800));
 } finally {globalThis.fetch=previous;}
});
