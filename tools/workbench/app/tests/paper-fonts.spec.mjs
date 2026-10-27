import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, webcrypto} from 'node:crypto';
import * as mupdf from 'mupdf';
import {createFontPlan, inspectFonts} from '../src/paper-fonts.mjs';
globalThis.crypto ||= webcrypto;
const fixture = name => readFileSync(new URL(`../node_modules/pdfjs-dist/standard_fonts/${name}`, import.meta.url));
const regular = () => ({id:'regular', family:'Liberation Sans', bytes:fixture('LiberationSans-Regular.ttf')});

test('actual coverage, numeric supplementary scalars and owned byte snapshot', async () => {
  const input = regular(), original = Buffer.from(input.bytes);
  const plan = await createFontPlan({text:'Ω𝐀'+String.fromCodePoint(0x10ffff), fonts:[input]}, {mupdf});
  const font = plan.candidates[0];
  assert.equal(font.sha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(font.hasGlyph(0x3a9), true);
  assert.equal(font.hasGlyph(0x1d400), false);
  assert.equal(font.hasGlyph(0x10ffff), false);
  assert.equal(font.hasGlyph(0x41), null);
  assert.equal(font.hasGlyph(NaN), null);
  assert.equal(font.hasGlyph(0xd800), null);
  assert.deepEqual(plan.missing, [0x1d400,0x10ffff]);
  assert.equal(plan.status, 'missing');
  input.bytes.fill(0); const copy = font.getBytes(); copy.fill(0);
  assert.deepEqual(Buffer.from(font.getBytes()), original);
});

test('one full face is selected consistently; otherwise ordered real fallback', async () => {
  const ding = {id:'ding',family:'Dingbats',bytes:fixture('FoxitDingbats.pfb')};
  const full = await createFontPlan({text:'AΩ',fonts:[ding,regular()]},{mupdf});
  assert.equal(full.selected.id,'regular');
  assert.deepEqual(full.fallback.map(x=>x.fontId),['regular','regular']);
  const plan = await createFontPlan({text:'A✁',fonts:[regular(),ding]},{mupdf});
  assert.equal(plan.selected,null);
  assert.equal(plan.status,'covered');
  assert.deepEqual(plan.fallback.map(x=>x.fontId),['regular','ding']);
});

test('invalid data and unavailable parser never prove coverage', async () => {
  const invalid = {id:'bad',family:'Not evidence',bytes:new Uint8Array([1,2,3])};
  const plan = await createFontPlan({text:'A',fonts:[invalid]},{mupdf});
  assert.equal(plan.status,'unavailable'); assert.equal(plan.hasGlyph(65),null);
  assert.equal(plan.candidates[0].coverage.status,'unavailable');
  assert.equal((await createFontPlan({text:'A',fonts:[regular()]})).status,'unavailable');
  assert.equal((await createFontPlan({text:'A',fonts:[]},{mupdf})).status,'unavailable');
  await assert.rejects(createFontPlan({text:'\ud800',fonts:[]},{mupdf}),/scalar/);
  await assert.rejects(createFontPlan({text:'A',fonts:[regular(),regular()]},{mupdf}),/unique/);
});

test('MuPDF resources are destroyed on success and failed parsing or inspection', async () => {
  let buffers=0, fonts=0;
  class BufferSpy extends mupdf.Buffer { destroy(){buffers++; super.destroy();} }
  class FontSpy extends mupdf.Font { destroy(){fonts++; super.destroy();} }
  await createFontPlan({text:'Ω',fonts:[regular(),{id:'bad',family:'bad',bytes:new Uint8Array([1])}]},{mupdf:{Buffer:BufferSpy,Font:FontSpy}});
  assert.equal(buffers,2); assert.equal(fonts,1);
  class ThrowFont extends FontSpy { encodeCharacter(){throw Error('inspection failed');} }
  const result=await createFontPlan({text:'A',fonts:[regular()]},{mupdf:{Buffer:BufferSpy,Font:ThrowFont}});
  assert.equal(result.status,'unavailable'); assert.equal(buffers,3); assert.equal(fonts,2);
});

test('legacy inspectFonts retains its callback contract', async () => {
  assert.deepEqual(await inspectFonts('ΩA',{hasGlyph:cp=>cp===0x3a9}),{status:'missing',missing:[65]});
  assert.equal((await inspectFonts('A')).status,'unavailable');
});

test('all font bytes are snapshotted before asynchronous hashing', async () => {
  const first=regular(), second={id:'ding',family:'Dingbats',bytes:fixture('FoxitDingbats.pfb')};
  const hash=createHash('sha256').update(second.bytes).digest('hex');
  const pending=createFontPlan({text:'A✁',fonts:[first,second]},{mupdf});
  second.bytes.fill(0);
  const plan=await pending;
  assert.equal(plan.candidates[1].sha256,hash);
  assert.equal(plan.candidates[1].hasGlyph(0x2701),true);
});


test('paragraph union distinguishes layout controls from actual missing glyphs', async () => {
  const text = 'Source line\nAfter\tΩ\rEnd';
  const plan = await createFontPlan({text, fonts:[regular()]}, {mupdf});
  assert.equal(plan.status, 'covered');
  assert.equal(plan.selected.id, 'regular');
  assert.deepEqual(plan.layoutControls, [10, 9, 13]);
  assert.deepEqual(plan.codepoints, [...new Set(Array.from(text, c => c.codePointAt(0)))]);
  assert.deepEqual(plan.fallback.filter(x => x.kind === 'layout-control').map(x => x.codepoint), [10, 9, 13]);
  assert.equal(plan.hasGlyph(10), null);
  assert.equal(plan.candidates[0].hasGlyph(10), null);
  assert.deepEqual(plan.missing, []);
  const missing = await createFontPlan({text:text+'\0'+String.fromCodePoint(0x10ffff), fonts:[regular()]}, {mupdf});
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.missing, [0, 0x10ffff]);
});

test('all candidate descriptors are captured before the first asynchronous hash', async () => {
  const first=regular(), second={id:'ding',family:'Dingbats',bytes:fixture('FoxitDingbats.pfb')};
  const firstHash=createHash('sha256').update(first.bytes).digest('hex');
  const secondHash=createHash('sha256').update(second.bytes).digest('hex');
  const pending=createFontPlan({text:'A✁',fonts:[first,second]},{mupdf});
  first.id='changed'; first.family='changed'; first.bytes.fill(0);
  second.id='changed'; second.family='changed'; second.bytes.fill(0);
  const plan=await pending;
  assert.deepEqual(plan.candidates.map(({id,family,sha256})=>({id,family,sha256})), [
    {id:'regular',family:'Liberation Sans',sha256:firstHash},
    {id:'ding',family:'Dingbats',sha256:secondHash},
  ]);
  assert.deepEqual(plan.fallback.map(({fontId,family})=>({fontId,family})), [
    {fontId:'regular',family:'Liberation Sans'}, {fontId:'ding',family:'Dingbats'},
  ]);
  assert.equal(plan.status,'covered');
});
