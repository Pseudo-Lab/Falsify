import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
const require=createRequire(import.meta.url), {build}=require('esbuild');
const root=new URL('../src/',import.meta.url);
const runtime=process.env.PARAGRAPH_RUNTIME_DIR || fileURLToPath(new URL('paragraph-vendor/runtime/',root));
const {default:create}=await import(pathToFileURL(resolve(runtime,'editcore.js')));
const bundle=await build({entryPoints:[fileURLToPath(new URL('paragraph-vendor/engine/core.js',root))],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'adapter',setup(b){b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:fileURLToPath(new URL('paragraph-pdf-engine-loader.mjs',root))}));b.onResolve({filter:/freetext-script$/},()=>({path:fileURLToPath(new URL('paragraph-vendor/utils/freetext-script.ts',root))}));}}]});
const {PdfEngine}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
function fixture(){
 const body='BT /F1 8.25 Tf 60 400 Td (epiblast) Tj ET';
 const make=(text,y=404.5,mode=0,x=91,right=100)=>`${body} BT /F1 4.95 Tf ${mode} Tr ${x} ${y} Td (${text}) Tj ET BT /F1 8.25 Tf ${right} 400 Td (, and) Tj ET`;
 const mixed=(secondX=93.75, rightX=103, extra='')=>`${body} BT /F2 4.95 Tf 91 404.5 Td (n) Tj ET BT /F1 4.95 Tf ${secondX} 404.5 Td (+1) Tj ET BT /F1 8.25 Tf ${rightX} 400 Td (, and) Tj ET ${extra}`;
 const streams=[make('n+1'),make('a',404.5,0,91,94),make('2-4'),make('-1',395.5,0,91,97),mixed(),make('n+1',404.5,3),make('n+1',404.5,0,260,380),`${body} BT /F1 4.95 Tf 65 404.5 Td (n+1) Tj ET`,mixed(100,110),mixed(93.75,103,'94 395 m 94 410 l S'),`${body} BT /F1 4.95 Tf 91 404.5 Td (legend) Tj ET`];
 const objs=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${streams.map((_,i)=>`${5+i*2} 0 R`).join(' ')}] /Count ${streams.length} >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>'];
 for(let i=0;i<streams.length;i++){const s=streams[i];objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6+i*2} 0 R >>`,`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);}
 let out='%PDF-1.4\n',offsets=[0];for(const [i,obj] of objs.entries()){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}const x=Buffer.byteLength(out);out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;return Buffer.from(out);
}
test('source-proven composite scripts retain text, size and rise without joining unrelated objects',async()=>{
 const M=await create({wasmBinary:readFileSync(join(runtime,'editcore.wasm')),print(){},printErr(){}}),cfg=M._malloc(48);M.HEAPU8.fill(0,cfg,cfg+48);M.HEAPU32[cfg>>2]=2;M._FPDF_InitLibraryWithConfig(cfg);M._free(cfg);
 const e=new PdfEngine(M);e.open(fixture());try{const models=[];for(let i=0;i<11;i++){e.loadPage(i);models.push(e.buildModel());}
 for(const [i,text] of ['n+1','a','2-4','-1'].entries()) {const p=models[i].find(p=>p.runs.some(r=>r.text.trim()===text));assert.ok(p,`missing ${text}`);assert.match(p.runs.map(r=>r.text).join(''),new RegExp(`epiblast\\s*${text.replace(/[+]/g,'\\$&')}\\s*, and`));const r=p.runs.find(r=>r.text.trim()===text);assert.ok(Math.abs(r.size-4.95)<0.01);assert.ok(Math.abs(r.rise-(i===3?-4.5:4.5))<0.01);}
 const mixedModel=models[4];const mixedPara=mixedModel.find(p=>p.runs.some(r=>r.text==='n'));assert.ok(mixedPara);assert.match(mixedPara.runs.map(r=>r.text).join(''),/epiblast\s*n\s*\+1\s*, and/);const parts=mixedPara.runs.filter(r=>r.text.trim()==='n'||r.text.trim()==='+1');assert.equal(parts.length,2);for(const r of parts){assert.ok(Math.abs(r.size-4.95)<0.01);assert.ok(Math.abs(r.rise-4.5)<0.01);}assert.notEqual(parts[0].italic,parts[1].italic);
 for(const model of models.slice(5)){const p=model.find(p=>p.runs.some(r=>r.text.includes('n+1')||r.text==='+1'||r.text==='legend'));assert.ok(p);assert.ok(!p.runs.some(r=>r.text.includes('epiblast')),JSON.stringify(model));}
 }finally{e.close();}
});
