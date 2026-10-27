import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {readDocument} from '../src/paper-document.mjs';
import {readSourceLinks} from '../src/paper-source-links.mjs';

function fixture(rotation=0) {
  const d=new mupdf.PDFDocument(), font=new mupdf.Font('Helvetica'), f=d.addSimpleFont(font);
  const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],false); pix.clear();
  const image=new mupdf.Image(pix), im=d.addImage(image);
  d.insertPage(0,d.addPage([0,0,200,300],rotation,{Font:{F:f},XObject:{Im:im}},'BT /F 12 Tf 20 250 Td (Duplicate) Tj 0 -25 Td (Duplicate) Tj 0 -25 Td (Wrapped) Tj 0 -15 Td (text) Tj ET q 30 0 0 30 100 100 cm /Im Do Q'));
  d.insertPage(1,d.addPage([0,0,200,300],0,{Font:{F:f}},'BT /F 12 Tf 20 250 Td (Destination) Tj ET'));
  const p=d.loadPage(0);
  if (rotation) p.setPageBox('CropBox',[10,20,180,280]);
  const boxes=rotation?[[20,20,80,40]]:[[19,36,80,54],[19,61,80,79],[19,86,80,119],[100,170,130,200],[19,36,80,54]];
  const uris=['https://example.org/a','https://doi.org/10.1234/example','#page=2&zoom=100,20,45','https://example.org/image','https://example.org/a'];
  for(let i=0;i<boxes.length;i++) {const l=p.createLink(boxes[i],uris[i]); l.destroy();}
  p.destroy(); const b=d.saveToBuffer(''), bytes=b.asUint8Array().slice(); b.destroy(); image.destroy(); pix.destroy(); font.destroy(); d.destroy(); return bytes;
}

test('actual PDF link occurrences, source binding and ownership',async()=>{
  const bytes=fixture(), copy=bytes.slice(), document=await readDocument({file:bytes}), before=structuredClone(document);
  const out=await readSourceLinks({bytes,document});
  assert.deepEqual(bytes,copy); assert.deepEqual(document,before); assert.equal(out.sourceSha256,document.sourceSha256); assert.equal(out.links.length,5);
  assert.equal(new Set(out.links.map(l=>l.id)).size,5); assert.deepEqual(out.links.map(l=>l.uri),['https://example.org/a','https://doi.org/10.1234/example','#page=2&zoom=100,20,45','https://example.org/image','https://example.org/a']);
  assert.equal(out.links[2].external,false); assert.equal(out.links[2].target.status,'resolved'); assert.equal(out.links[2].target.pageIndex,1); assert.equal(out.links[2].target.relation.status,'text');
  assert.equal(out.links[3].relation.status,'asset'); assert.equal(out.links[3].relation.assetIds.length,1);
  assert.ok(out.links[0].relation.ranges.length); assert.ok(out.links[1].relation.ranges.length); assert.notDeepEqual(out.links[0].relation.ranges,out.links[1].relation.ranges);
  assert.ok(out.links[2].relation.ranges.length); assert.ok(Object.isFrozen(out.links[0].source.bbox));
  assert.deepEqual((await readSourceLinks({bytes,document})).links.map(x=>x.id),out.links.map(x=>x.id));
  await assert.rejects(readSourceLinks({bytes,document:{...document,sourceSha256:'0'.repeat(64)}}),/hash mismatch/);
  const controller=new AbortController(); controller.abort(); await assert.rejects(readSourceLinks({bytes,document,signal:controller.signal}),{name:'AbortError'});
  const later=new AbortController(), pending=readSourceLinks({bytes,document,signal:later.signal}); setTimeout(()=>later.abort(),0); await assert.rejects(pending,{name:'AbortError'});
  const bad=structuredClone(document); bad.blocks[0].source.characters[0].end=999; await assert.rejects(readSourceLinks({bytes,document:bad}),/Unsafe source character range/);
  for(let i=0;i<5;i++) assert.equal((await readSourceLinks({bytes,document})).links.length,5);
});
test('rotation and crop use verified MuPDF display frame',async()=>{
  const bytes=fixture(90), document=await readDocument({file:bytes}), out=await readSourceLinks({bytes,document});
  assert.equal(out.frames[0].verified,true); assert.deepEqual(out.frames[0].bounds,document.pages[0].geometry.bounds); assert.deepEqual(out.links[0].source.bbox,[20,20,80,40]);
  const altered=structuredClone(document); altered.pages[0].geometry.pageTransform[4]++;
  const uncertain=await readSourceLinks({bytes,document:altered}); assert.equal(uncertain.frames[0].verified,false); assert.equal(uncertain.links[0].relation.reason,'page-frame-unverified');
});

test('subpixel link edge retains only uniquely owned glyphs',async()=>{
  const bytes=fixture(), document=await readDocument({file:bytes});
  const original=await readSourceLinks({bytes,document}), bounds=original.links[0].source.bbox;
  const block=document.blocks.find(b=>b.source.characters?.length && b.source.pageIndex===0 && b.text==='Duplicate');
  const chars=block.source.characters;
  // Match a measured 0.079 point overshoot; the next letter lies outside.
  chars[0].bbox=[bounds[0]+1,bounds[1]+1,bounds[2]+0.079,bounds[3]-1];
  chars[1].bbox=[bounds[2]+0.01,bounds[1]+1,bounds[2]+3,bounds[3]-1];
  const out=await readSourceLinks({bytes,document});
  assert.ok(out.links[0].relation.ranges.some(r=>r.blockId===block.id && r.start===chars[0].start && r.end===chars[0].end));
  assert.ok(!out.links[0].relation.ranges.some(r=>r.blockId===block.id && r.start<=chars[1].start && r.end>=chars[1].end));
  assert.deepEqual(out.links[0].source.bbox,bounds); assert.equal(out.sourceSha256,document.sourceSha256);
  chars[1].bbox=[...chars[0].bbox];
  const ambiguous=await readSourceLinks({bytes,document});
  assert.equal(ambiguous.links[0].relation.reason,'ambiguous-character-geometry');
  assert.deepEqual(ambiguous.links[0].relation.ranges,[]);
});
