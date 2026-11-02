import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadReconstructionFonts} from '../src/pdf-latex-fonts.mjs';
test('flow font loader pins all four real faces and owns their bytes',async()=>{
  const calls=[];
  const fetch=async path=>{calls.push(path);const bytes=await readFile(new URL('../dist/'+path.replace(/^\.\//,''),import.meta.url));return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};};
  const first=await loadReconstructionFonts({fetch});
  assert.equal(calls.length,5);assert.ok(calls.every(p=>p.includes('LiberationSerif-')||p.includes('STIXTwoMath-')));
  assert.deepEqual(first.map(f=>f.style),['regular','bold','italic','bolditalic','regular']);
  assert.ok(first.slice(0,4).every(f=>f.role==='serif'&&f.bytes.length>10000));assert.equal(first[4].role,'math');
  const original=first[0].bytes[0];first[0].bytes[0]^=255;
  const again=await loadReconstructionFonts({fetch});assert.equal(again[0].bytes[0],original);
});
test('corrupt downloaded font is rejected before project creation',async()=>{
  await assert.rejects(loadReconstructionFonts({fetch:async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([0,1,2]).buffer})}),/Font hash mismatch/);
});
