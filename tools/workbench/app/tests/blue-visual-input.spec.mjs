import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto, createHash} from 'node:crypto';
import {renderBlueVisuals} from '../src/blue-visual-input.mjs';
const digest = b => createHash('sha256').update(b).digest('hex');
const pdfBytes = new TextEncoder().encode('%PDF-1.7 synthetic');
const png = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
function fixture() {
  let destroyed=0, cleaned=0, rendered=[];
  const page={getViewport:({scale})=>({width:200*scale,height:100*scale,rotation:90}),
    render:opts=>{rendered.push(opts);return {promise:Promise.resolve()};},cleanup:()=>cleaned++};
  const canvas={getContext:()=>({}),toBlob:cb=>cb(new Blob([png],{type:'image/png'}))};
  const file={size:pdfBytes.length,arrayBuffer:async()=>pdfBytes.slice().buffer};
  const args={file,fileHash:digest(pdfBytes),sourceHash:'a'.repeat(64),selections:[{page:1,bbox:[10,20,40,30]}],
    baseURI:'https://localhost/',subtle:webcrypto.subtle,document:{createElement:()=>canvas},
    importPdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>page}),destroy:async()=>destroyed++})})};
  return {args,rendered,counts:()=>[cleaned,destroyed]};
}
test('binds rendered immutable bytes to verified file and rotated viewport selection',async()=>{
  const f=fixture(), [v]=await renderBlueVisuals(f.args);
  assert.deepEqual([v.fileHash,v.sourceHash,v.page,v.bbox,v.rotation,v.width,v.height,v.sha256],
    [digest(pdfBytes),'a'.repeat(64),1,[10,20,40,30],90,80,60,digest(png)]);
  assert.deepEqual(Buffer.from(v.base64,'base64'),Buffer.from(png));
  assert.deepEqual(f.rendered[0].transform,[1,0,0,1,-20,-40]);
  assert.deepEqual(f.counts(),[1,1]);
});
test('rejects stale file and out-of-bounds selection without clipping',async()=>{
  let f=fixture();f.args.fileHash='b'.repeat(64);
  await assert.rejects(renderBlueVisuals(f.args),/visual_file_hash_mismatch/);
  f=fixture();f.args.selections[0].bbox=[190,0,20,10];
  await assert.rejects(renderBlueVisuals(f.args),/visual_bbox_out_of_bounds/);
  assert.deepEqual(f.counts(),[1,1]);
});
test('rejects count, page and unknown fields',async()=>{
  let f=fixture();f.args.selections=Array(4).fill({page:1,bbox:[0,0,1,1]});
  await assert.rejects(renderBlueVisuals(f.args),/visual_input_invalid/);
  f=fixture();f.args.selections=[{page:2,bbox:[0,0,1,1]}];
  await assert.rejects(renderBlueVisuals(f.args),/visual_selection_invalid/);
  f=fixture();f.args.selections=[{page:1,bbox:[0,0,1,1],path:'../private'}];
  await assert.rejects(renderBlueVisuals(f.args),/visual_selection_invalid/);
});
