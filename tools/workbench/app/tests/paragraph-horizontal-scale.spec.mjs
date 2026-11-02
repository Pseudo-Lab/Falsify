import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, join} from 'node:path';

const require = createRequire(import.meta.url), {build} = require('esbuild');
const root = new URL('../src/', import.meta.url);
const runtime = process.env.PARAGRAPH_RUNTIME_DIR || fileURLToPath(new URL('paragraph-vendor/runtime/', root));
const {default: create} = await import(pathToFileURL(resolve(runtime, 'editcore.js')));
const bundle = await build({entryPoints:[fileURLToPath(new URL('paragraph-vendor/engine/core.js', root))], bundle:true, write:false, format:'esm', platform:'node', plugins:[{name:'adapter', setup(b) {
  b.onResolve({filter:/^\.\/engine-loader\.js$/}, () => ({path:fileURLToPath(new URL('paragraph-pdf-engine-loader.mjs', root))}));
  b.onResolve({filter:/freetext-script$/}, () => ({path:fileURLToPath(new URL('paragraph-vendor/utils/freetext-script.ts', root))}));
}}]});
const {PdfEngine} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

function fixture(customStreams) {
  const matrices = ['8.2319 0 0 8.25', '8.2665 0 0 8.25', '8.25 0 0 8.25', '0 8.2319 -8.25 0', '0 0 0 8.25'];
  const streams = customStreams ?? matrices.map(m => `BT /F1 1 Tf ${m} 60 200 Tm (Scale test) Tj ET`);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${streams.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${streams.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i,s] of streams.entries()) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`, `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  let pdf='%PDF-1.4\n', offsets=[0];
  for (const [i,obj] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`; }
  const x=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function compositeFixture() {
  const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 2 beginbfchar <006c> <006c> <0020> <0020> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const streams=['BT /F1 12 Tf 1 Tc 1 0 0 1 60 200 Tm <006c0020006c> Tj ET','BT /F1 12 Tf 1 0 0 1 60 200 Tm [<006c0020> -180 <006c>] TJ ET'];
  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [6 0 R 8 0 R] /Count 2 >>','<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>','<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /CIDToGIDMap /Identity >>',`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`];
  for(const [i,s] of streams.entries()) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${7+i*2} 0 R >>`,`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  let pdf='%PDF-1.4\n',offsets=[0]; for(const [i,obj] of objs.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const x=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(pdf);
}

test('native model retains small horizontal scales, including rotated text', async () => {
  const M=await create({wasmBinary:readFileSync(join(runtime,'editcore.wasm')),print(){},printErr(){}});
  const cfg=M._malloc(48); M.HEAPU8.fill(0,cfg,cfg+48); M.HEAPU32[cfg>>2]=2; M._FPDF_InitLibraryWithConfig(cfg); M._free(cfg);
  const e=new PdfEngine(M); e.open(fixture());
  try {
    for (const [i, expected] of [8.2319/8.25, 1.002, 1, 8.2319/8.25].entries()) {
      e.loadPage(i);
      const runs=e.buildModel().flatMap(p=>p.runs);
      const run=runs.find(r=>r.text.includes('Scale'));
      assert.ok(run, `missing text on page ${i}`);
      assert.ok(Number.isFinite(run.hScale) && run.hScale > 0);
      assert.ok(Math.abs(run.hScale-expected)<0.000001, `page ${i}: ${run.hScale} vs ${expected}`);
    }
    e.loadPage(4);
    for (const run of e.buildModel().flatMap(p=>p.runs)) assert.ok(Number.isFinite(run.hScale) && run.hScale > 0);
  } finally { e.close(); }
});

test('repeated no-op model builds preserve word-spaced object ownership and geometry', async () => {
  const M=await create({wasmBinary:readFileSync(join(runtime,'editcore.wasm')),print(){},printErr(){}});
  const cfg=M._malloc(48); M.HEAPU8.fill(0,cfg,cfg+48); M.HEAPU32[cfg>>2]=2; M._FPDF_InitLibraryWithConfig(cfg); M._free(cfg);
  const e=new PdfEngine(M);
  e.open(fixture(['BT /F1 12 Tf 2 Tw 1 0 0 1 60 200 Tm (word spaced text) Tj ET']));
  try {
    e.loadPage(0);
    const first=e.buildModel();
    const snapshot=() => Array.from({length:M._FPDFPage_CountObjects(e.page)}, (_, i) => {
      const h=M._FPDFPage_GetObject(e.page,i) >>> 0;
      return {h, bounds:e.objectBounds(h)};
    });
    const objects=snapshot();
    for (let i=0; i<3; i++) {
      const next=e.buildModel();
      assert.deepEqual(snapshot(), objects);
      assert.deepEqual(next.map(p=>p.runs.map(r=>r.text).join('')), first.map(p=>p.runs.map(r=>r.text).join('')));
    }
  } finally { e.close(); }
});

test('Tc and explicit TJ spacing survive model builds and save/reload', async () => {
  const M=await create({wasmBinary:readFileSync(join(runtime,'editcore.wasm')),print(){},printErr(){}});
  const cfg=M._malloc(48); M.HEAPU8.fill(0,cfg,cfg+48); M.HEAPU32[cfg>>2]=2; M._FPDF_InitLibraryWithConfig(cfg); M._free(cfg);
  const streams=[
    'BT /F1 12 Tf 1.1 Tc 1 0 0 1 60 200 Tm (one two three) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 60 200 Tm [(one ) -180 (two ) -180 (three)] TJ ET',
  ];
  const e=new PdfEngine(M); e.open(fixture(streams));
  const glyphs=()=>{
    const tp=M._FPDFText_LoadPage(e.page), p=M._malloc(16), out=[];
    try { for(let i=0,n=M._FPDFText_CountChars(tp);i<n;i++) {
      const u=M._FPDFText_GetUnicode(tp,i);
      if (u && M._FPDFText_GetCharOrigin(tp,i,p,p+8)) out.push([u,M.HEAPF64[p>>3],M.HEAPF64[(p+8)>>3]]);
    } } finally { M._free(p); M._FPDFText_ClosePage(tp); }
    return out;
  };
  const same=(a,b)=>{ assert.equal(b.length,a.length); a.forEach((v,i)=>{assert.equal(b[i][0],v[0]); assert.ok(Math.abs(v[1]-b[i][1])<0.02); assert.ok(Math.abs(v[2]-b[i][2])<0.02);}); };
  try {
    for(let page=0;page<4;page++) {
      if (page===2) e.open(compositeFixture());
      const pageIndex=page%2;
      e.loadPage(pageIndex); const original=glyphs(); assert.ok(original.length>=3);
      if (page>=2) assert.deepEqual(original.map(g=>g[0]),[108,32,108]);
      e.buildModel(); same(original,glyphs());
      const objects=Array.from({length:M._FPDFPage_CountObjects(e.page)},(_,i)=>M._FPDFPage_GetObject(e.page,i)>>>0);
      e.buildModel(); same(original,glyphs());
      assert.deepEqual(Array.from({length:M._FPDFPage_CountObjects(e.page)},(_,i)=>M._FPDFPage_GetObject(e.page,i)>>>0),objects);
      e.historyBeginStep('spacing-undo');
      e.historyNoteMatrix(objects[0]); e.translateObject(objects[0],3,0);
      e.historyEndStep(); assert.ok(e.historyUndo()); same(original,glyphs());
      e.buildModel(); same(original,glyphs());
      assert.deepEqual(Array.from({length:M._FPDFPage_CountObjects(e.page)},(_,i)=>M._FPDFPage_GetObject(e.page,i)>>>0),objects);
      e.generateContent(); const bytes=e.save(); e.reopen(bytes,pageIndex); same(original,glyphs());
      e.buildModel(); same(original,glyphs());
      let para=e.buildModel().find(p=>p.editable && p.runs.some(r=>r.text.trim()));
      assert.ok(para);
      const edited=para.runs.map((r,i)=>({...r,sourceIndex:i,text:r.text.replace(page>=2?'l':'one','')}));
      e.historyBeginStep('spacing-edit'); assert.ok(e.commitParagraph(para.id,edited,para.format)); e.historyEndStep();
      assert.ok(e.historyUndo()); same(original,glyphs());
      para=e.buildModel().find(p=>p.editable && p.runs.some(r=>r.text.trim())); assert.ok(para);
      const editedAgain=para.runs.map((r,i)=>({...r,sourceIndex:i,text:r.text.replace(page>=2?'l':'one','')}));
      e.historyBeginStep('spacing-reedit'); assert.ok(e.commitParagraph(para.id,editedAgain,para.format)); e.historyEndStep();
      const expected=original.map(g=>String.fromCodePoint(g[0])).join('').replace(page>=2?'l':'one','');
      assert.equal(glyphs().map(g=>String.fromCodePoint(g[0])).join('').trim(),expected.trim());
    }
  } finally { e.close(); }
});
