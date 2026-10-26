import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Worker as NodeWorker} from 'node:worker_threads';
import vm from 'node:vm';
import {inspectTables,checkFit} from '../dist/table-pdf-worker.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function fixture({rows=13,prose=false,overlap=false}={}){
  const height=Math.max(500,rows*20+80);let body='0 0 0 RG .5 w\n';
  if(!prose){for(const x of [40,160,280])body+=`${x} 40 m ${x} ${height-40} l S\n`;for(let r=0;r<=rows;r++)body+=`40 ${height-40-r*20} m 280 ${height-40-r*20} l S\n`;}
  for(let r=0;r<rows;r++)for(const [x,s]of [[50,prose?'Long prose sentence':r?'Row'+r:'Name'],[170,prose?'Other prose column':r?'10':'Value']])body+=`BT /F1 8 Tf 1 0 0 1 ${x} ${height-53-r*20} Tm (${s}) Tj ET\n`;
  if(overlap)body+=`BT /F1 8 Tf 1 0 0 1 170 ${height-73} Tm (10) Tj ET\n`;
  const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`];
  let out='%PDF-1.4\n',offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(out));
}
const request=(bytes,revision='r1')=>({bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),fileHash:sha(bytes),revision,pageIndex:0});
test('real MuPDF WASM selections bind twelve repeats and stable source aliases across editor revisions',async()=>{
  const bytes=fixture(),a=await inspectTables(request(bytes)),b=await inspectTables(request(bytes,'r2'));
  const last=a.cells.find(c=>c.row===12&&c.col===1);assert.equal(last.selection.status,'ready');assert.equal(last.selection.before,'10');assert.equal(last.selection.anchor.occurrence,undefined);
  assert.notDeepEqual(last.cellBbox,last.selection.anchor.bbox);assert.equal(last.alias,b.cells.find(c=>c.row===12&&c.col===1).alias);
  assert.notEqual(last.selection.cellId,b.cells.find(c=>c.row===12&&c.col===1).selection.cellId);
  assert.ok(!Object.hasOwn(a,'model'));assert.ok(a.cells.every(c=>!Object.hasOwn(c,'runIds')));
  await assert.rejects(()=>inspectTables({...request(bytes),fileHash:'0'.repeat(64)}),{code:'stale-source'});
});
test('real worker message owns WASM and outputs serializable selections only',async()=>{
  const url=new URL('../dist/table-pdf-worker.mjs',import.meta.url).href;
  const worker=new NodeWorker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:x=>parentPort.postMessage(x)};import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,{eval:true});
  try{const result=new Promise((resolve,reject)=>{worker.on('message',value=>{if(value.ok!==undefined)resolve(value);});worker.once('error',reject);});const r=request(fixture());worker.postMessage({id:7,...r},[r.bytes]);const reply=await result;assert.equal(reply.ok,true);assert.equal(reply.id,7);assert.equal(reply.result.cells.length,26);}finally{await worker.terminate();}
});
test('prose is not a table; overlapping cells unsupported; visible overlay results capped at 500',async()=>{
  assert.equal((await inspectTables(request(fixture({rows:3,prose:true})))).cells.length,0);
  const bad=await inspectTables(request(fixture({rows:3,overlap:true})));assert.ok(bad.cells.some(c=>c.selection.status==='unsupported'));
  const big=await inspectTables(request(fixture({rows:260})));assert.equal(big.cells.length,500);assert.equal(big.truncated,true);assert.ok(big.totalCells>500);
});
test('classic loader is lazy, isolates workers, cancels and rejects stale echoed bindings',async()=>{
  const made=[];class Worker{constructor(url){this.url=url;made.push(this);}postMessage(data){this.data=data;}terminate(){this.terminated=true;}}
  const context=vm.createContext({document:{currentScript:{src:'https://example.test/app/table-pdf.js?v=fixed'}},URL,Worker,Uint8Array,Promise,Error,setTimeout,clearTimeout});
  vm.runInContext(readFileSync(new URL('../dist/table-pdf.js',import.meta.url),'utf8'),context);assert.equal(made.length,0);
  const bytes=fixture(),file={arrayBuffer:async()=>bytes.buffer.slice(0)},abort=new AbortController();
  const p=context.FalsifyTablePdf.inspectPage({file,fileHash:sha(bytes),revision:'r1',pageIndex:0,signal:abort.signal});
  await new Promise(setImmediate);assert.equal(made.length,1);assert.equal(made[0].url.origin,'https://example.test');assert.equal(made[0].data,undefined);made[0].onmessage({data:{ready:true}});abort.abort();await assert.rejects(p,{code:'aborted'});assert.equal(made[0].terminated,true);
  const q=context.FalsifyTablePdf.inspectPage({file,fileHash:sha(bytes),revision:'r1',pageIndex:0});await new Promise(setImmediate);const worker=made[1];worker.onmessage({data:{ready:true}});worker.onmessage({data:{id:worker.data.id,ok:true,result:{fileHash:sha(bytes),revision:'wrong',pageIndex:0}}});await assert.rejects(q,{code:'stale-selection'});assert.equal(worker.terminated,true);
  const success=context.FalsifyTablePdf.inspectPage({file,fileHash:sha(bytes),revision:'r1',pageIndex:0});await new Promise(setImmediate);const own=made[2];own.onmessage({data:{ready:true}});own.onmessage({data:{id:own.data.id,ok:true,result:{fileHash:sha(bytes),revision:'r1',pageIndex:0,cells:[]}}});assert.equal((await success).cells.length,0);assert.equal(own.terminated,true);
});

test('generated table glyphs crossing immutable cell bounds produce overflow warning evidence',async()=>{
  const bytes=fixture(),model=await inspectTables(request(bytes)),cell=model.cells.find(c=>c.row===12&&c.col===1),{prepare}=await import('../dist/browser-pdf.mjs');
  const after='123456789012345678901234567890',result=await prepare({file:bytes,fileHash:sha(bytes),edits:[{id:'last',pageIndex:0,before:'10',after,anchor:cell.selection.anchor}]});
  const out=new Uint8Array(await result.file.arrayBuffer()),fit=await checkFit({...request(out),cells:[{id:'last',pageIndex:0,bbox:cell.cellBbox,after}]});assert.equal(fit.results[0].status,'overflow');
});
