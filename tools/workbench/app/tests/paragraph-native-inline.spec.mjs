import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import create from '../src/paragraph-vendor/runtime/editcore.js';
const require = createRequire(import.meta.url), {build} = require('esbuild');
const root = new URL('../src/', import.meta.url);
const bundle = await build({entryPoints:[fileURLToPath(new URL('paragraph-vendor/engine/core.js',root))], bundle:true, write:false, format:'esm', platform:'node', plugins:[{name:'adapter',setup(b){b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:fileURLToPath(new URL('paragraph-pdf-engine-loader.mjs',root))}));b.onResolve({filter:/freetext-script$/},()=>({path:fileURLToPath(new URL('paragraph-vendor/utils/freetext-script.ts',root))}));}}]});
const {PdfEngine}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
function fixture() {
 const streams=[
 'BT /F1 8.25 Tf 60 400 Td (epiblast) Tj ET BT /F1 4.95 Tf 91 403.506 Td (62) Tj ET BT /F1 8.25 Tf 97 400 Td (, and) Tj ET',
 'BT /F1 8.25 Tf 60 400 Td (normal row above) Tj 0 -30 Td (normal row below) Tj ET',
 'BT /F1 8.25 Tf 60 400 Td (overlay body) Tj ET BT /F1 4.95 Tf 60 400 Td (62) Tj ET',
 'BT /F1 8.25 Tf 60 400 Td (left column) Tj ET BT /F1 4.95 Tf 260 403.506 Td (62) Tj ET BT /F1 8.25 Tf 380 400 Td (right column) Tj ET',
 'BT /F1 8.25 Tf 20 400 Td (Independent left column stays separate.) Tj ET BT /F1 8.25 Tf 300 400 Td (epiblast) Tj ET BT /F1 4.95 Tf 331 403.506 Td (62) Tj ET BT /F1 8.25 Tf 337 400 Td (, and) Tj ET'];
 const objs=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${streams.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${streams.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(let i=0;i<streams.length;i++){const s=streams[i];objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);}
 let out='%PDF-1.4\n', offsets=[0];for(const [i,obj] of objs.entries()){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const x=Buffer.byteLength(out);out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(out);
}
test('native grouping retains raised marker and keeps unrelated text separate',async()=>{
 const M=await create({wasmBinary:readFileSync(new URL('../src/paragraph-vendor/runtime/editcore.wasm',import.meta.url)),print(){},printErr(){}}); const cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);
 const e=new PdfEngine(M);e.open(fixture());try{const models=[];for(let i=0;i<5;i++){e.loadPage(i);models.push(e.buildModel());}
 const positive=models[0].find(p=>p.runs.some(r=>r.text.includes('62')));assert.ok(positive);assert.ok(positive.runs.some(r=>r.text.includes('epiblast')));assert.ok(positive.runs.some(r=>r.text.includes(', and')));assert.match(positive.runs.map(r=>r.text).join(''), /epiblast\s*62\s*, and/);const marker=positive.runs.find(r=>r.text.includes('62'));assert.ok(Math.abs(marker.size-4.95)<0.01);assert.ok(Math.abs(marker.rise-3.506)<0.01);
 for(const model of models.slice(1,4)) assert.ok(model.length>=2,JSON.stringify(model.map(p=>p.runs.map(r=>r.text))));
 const interleaved=models[4].find(p=>p.runs.some(r=>r.text.includes('62')));
 assert.match(interleaved.runs.map(r=>r.text).join(''),/epiblast\s*62\s*, and/);
 assert.ok(!interleaved.runs.some(r=>r.text.includes('Independent left')));
 }finally{e.close();}
});
