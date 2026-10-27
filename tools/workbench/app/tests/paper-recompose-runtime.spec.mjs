import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import * as mupdf from 'mupdf';
import {createRuntime} from '../src/paper-recompose-runtime.mjs';
import {runRequest,remapBindings,resolveAsset,loadAssets} from '../src/paper-recompose-worker.mjs';
import {normalizeDocument} from '../src/paper-document.mjs';
import {readDocument} from '../src/paper-document.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const sha=b=>createHash('sha256').update(b).digest('hex');
const fixture=marked=>{const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));d.insertPage(-1,d.addPage([0,0,612,792],0,{Font:{helv:font}},'BT /helv 12 Tf 30 700 Td (Publisher and body remain) Tj ET'));if(marked){const p=d.findPage(0),prev=p.get('Contents'),hex='46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';p.put('Contents',[prev,d.addStream('q 25 13 562 14 re h .98 .94 .87 rg f Q',{}),d.addStream(`q BT 1 0 0 1 30 17.8 Tm /helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<${hex}>]TJ ET Q`,{})]);}const b=d.saveToBuffer(),out=b.asUint8Array().slice();b.destroy();d.destroy();return out;};
function mock(){return {terminated:0,postMessage(data,transfer){this.data=data;this.transfer=transfer;},terminate(){this.terminated++;},send(data){this.onmessage?.({data});}};}
test('owned buffers, ignored messages, findings and verified output',async()=>{const w=mock(),bytes=new Uint8Array([1,2]),edits=[{after:'x'}],r=createRuntime({workerFactory:()=>w}).prepare({file:bytes,edits,revision:3});edits[0].after='changed';assert.equal(w.data.request.edits[0].after,'x');assert.notEqual(w.data.request.file.buffer,bytes.buffer);assert.equal(w.transfer[0],w.data.request.file.buffer);w.send({id:999,type:'result'});w.send({id:w.data.id,type:'progress'});const f=new File(['pdf'],'x.pdf');w.send({id:w.data.id,type:'result',result:{file:f,sha256:sha(Buffer.from('pdf')),revision:3,verification:{status:'finding'}}});const result=await r;assert.equal(result.verification.status,'finding');assert.equal(w.terminated,1);assert.deepEqual([...bytes],[1,2]);});
test('cancellation and invalid replies terminate',async()=>{const c=new AbortController();c.abort();let created=false;await assert.rejects(createRuntime({workerFactory:()=>{created=true;}}).prepare({signal:c.signal}),{name:'AbortError'});assert.equal(created,false);const w=mock(),d=new AbortController(),p=createRuntime({workerFactory:()=>w}).prepare({file:new Uint8Array([1]),edits:[],signal:d.signal});d.abort();await assert.rejects(p,{name:'AbortError'});assert.equal(w.terminated,1);const x=mock(),q=createRuntime({workerFactory:()=>x}).prepare({file:new Uint8Array([1]),edits:[],revision:1});x.send({id:x.data.id,type:'result',result:{file:new File(['x'],'x'),sha256:'0'.repeat(64),revision:1}});await assert.rejects(q,/hash mismatch/);assert.equal(x.terminated,1);});
test('manifest confines assets to subpath and verifies bytes',async()=>{const url='https://example.org/repo/app/dist/recomposition-vendor/manifest.json';assert.equal(resolveAsset('font.ttf',url),'https://example.org/repo/app/dist/recomposition-vendor/font.ttf');for(const p of ['../secret','https://evil/a','%2e%2e/x']) assert.throws(()=>resolveAsset(p,url),{code:'asset-path'});const data=new Uint8Array([1,2]);const manifest={version:'falsify.recomposition-runtime.v1',compilerModule:'../recomposition-typst.mjs',wasm:{url:'x.wasm',sha256:sha(data)},fonts:[]};const fetcher=async u=>u===url?{ok:true,json:async()=>manifest}:{ok:true,arrayBuffer:async()=>data.buffer};assert.equal((await loadAssets(url,fetcher)).compilerURL,'https://example.org/repo/app/dist/recomposition-typst.mjs');manifest.wasm.sha256='0'.repeat(64);await assert.rejects(loadAssets(url,fetcher),{code:'asset-hash'});});
test('real footer cleanup preserves provenance and enables running furniture',async()=>{for(const marked of [false,true]){const bytes=fixture(marked), before=bytes.slice();let seen,options;const result=await runRequest({file:bytes,fileHash:sha(bytes),edits:[],revision:9},{assets:{fonts:[]},pdfjs:{},facade:{},compile:()=>{},recompose:async (request,opts)=>{seen=request;options=opts;return {file:new File(['pdf'],'out.pdf'),sha256:sha(Buffer.from('pdf')),revision:9,sourceBinding:{sourceSha256:request.fileHash}};}});assert.deepEqual(bytes,before);assert.equal(options.runningFurniture,true);assert.equal(result.sourceBinding.originalSha256,sha(bytes));assert.equal(result.sourceBinding.preparedSha256,seen.fileHash);assert.equal(result.sourceBinding.preparedSha256===sha(bytes),!marked);}});
test('exact character geometry remaps and ambiguous geometry fails',()=>{const make=(hash,dup=false)=>normalizeDocument({sourceSha256:hash,pages:[{width:100,height:100,blocks:Array.from({length:dup?2:1},()=>({bbox:[0,0,2,1],chars:[{text:'a',bbox:[0,0,1,1]},{text:'b',bbox:[1,0,2,1]}]})),images:[]}]});const old=make('a'.repeat(64)),now=make('b'.repeat(64)),b=old.blocks[0],sel={sourceSha256:old.sourceSha256,parts:[{blockId:b.id,pageIndex:0,start:0,end:2,before:'ab'}]};assert.equal(remapBindings(old,now,[sel])[0].parts[0].before,'ab');assert.throws(()=>remapBindings(old,make('b'.repeat(64),true),[sel]),{code:'source-binding'});now.blocks[0].source.characters[0].bbox[0]=3;assert.throws(()=>remapBindings(old,now,[sel]),{code:'source-binding'});});

test('real cleaned source maps original selection and retains request text',async()=>{const bytes=fixture(true),edits=[{id:'edit',pageIndex:0,before:'Publisher and body remain',after:'Changed'}];let seen;const result=await runRequest({file:bytes,fileHash:sha(bytes),edits,revision:1},{assets:{fonts:[]},pdfjs:{},facade:{},compile:()=>{},recompose:async req=>{seen=req;return {revision:1,sourceBinding:{},bindings:[]};}});assert.equal(seen.bindings.length,1);assert.equal(seen.bindings[0].parts.map(p=>p.before).join(''),'Publisher and body remain');assert.equal(seen.edits.edits[0].after,'Changed');assert.equal(result.sourceBinding.originalSha256,sha(bytes));});

test('cleanup prebinding uses byte-proven word gaps before remapping native glyphs',async()=>{
 pdfjs.GlobalWorkerOptions.workerSrc=new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href;
 const bytes=fixture(true), copy=bytes.slice();let seen;
 // Represent a source reader that omits space glyphs but retains their geometric gaps.
 const read=async input=>{const d=await readDocument(input);for(const page of d.pages){let offset=0;for(const b of d.blocks.filter(b=>b.source.pageIndex===page.sourcePageIndex)){
  const base=b.source.range.start,original=b.text;const chars=b.source.characters.filter(c=>original.slice(c.start-base,c.end-base)!==' ');let text='';
  for(const c of chars){const value=original.slice(c.start-base,c.end-base);c.start=offset;c.end=offset+value.length;offset=c.end;text+=value;}
  b.text=text;b.source.characters=chars;b.source.range={start:chars[0].start,end:chars.at(-1).end};for(const line of b.source.lines)line.range={...b.source.range};
 }page.text=d.blocks.filter(b=>b.source.pageIndex===page.sourcePageIndex).map(b=>b.text).join('');}return d;};
 const before='Publisher and body remain',after='Changed paragraph';
 const out=await runRequest({file:bytes,fileHash:sha(bytes),edits:[{id:'gaps',pageIndex:0,before,after}],revision:17},{readDocument:read,assets:{fonts:[]},pdfjs:{getDocument:options=>pdfjs.getDocument(options)},facade:{},compile:()=>{},recompose:async request=>{seen=request;return {revision:17,sourceBinding:{}};}});
 assert.deepEqual(bytes,copy);assert.equal(out.sourceBinding.originalSha256,sha(bytes));
 assert.equal(seen.bindings.length,1);assert.equal(seen.bindings[0].parts.map(p=>p.before).join(''),'Publisherandbodyremain');assert.equal(seen.edits.edits[0].before,before);assert.equal(seen.edits.edits[0].after,after);
});
test('postMessage failure and stale result terminate',async()=>{const w=mock();w.postMessage=()=>{throw Error('transfer failed');};await assert.rejects(createRuntime({workerFactory:()=>w}).prepare({file:new Uint8Array([1]),edits:[]}),/transfer failed/);assert.equal(w.terminated,1);const x=mock(),p=createRuntime({workerFactory:()=>x}).prepare({file:new Uint8Array([1]),edits:[],revision:1});x.send({id:x.data.id,type:'result',result:{file:new File(['x'],'x'),sha256:sha(Buffer.from('x')),revision:2}});await assert.rejects(p,/Invalid recomposition/);assert.equal(x.terminated,1);});

test('an opted-in layout mode survives footer cleanup and the worker boundary',async()=>{
 const bytes=fixture(true);let observed;
 await runRequest({file:bytes,fileHash:sha(bytes),edits:[],revision:3,layoutMode:'measured-continuous'},{assets:{fonts:[]},pdfjs:{},facade:{},compile:()=>{},recompose:async req=>{observed=req;return {revision:3,sourceBinding:{}};}});
 assert.equal(observed.layoutMode,'measured-continuous');assert.notEqual(observed.fileHash,sha(bytes));
 let started=0;
 await assert.rejects(createRuntime({workerFactory:()=>{started++;return mock();}}).prepare({file:bytes,edits:[],layoutMode:'execute-text'}),/Unknown layout mode/);
 assert.equal(started,0);
 await assert.rejects(runRequest({file:bytes,edits:[],layoutMode:{value:'measured-continuous'}}),/Unknown layout mode/);
});

