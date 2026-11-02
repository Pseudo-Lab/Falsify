import test from 'node:test';
import assert from 'node:assert/strict';
import {scanTextShows} from '../src/paragraph-pdf-content-operators.mjs';

const bytes = p => [...p.bytes];
test('lexes bytes and spans without matching operators in strings, comments or dictionaries', () => {
  const input = 'BT /F#31 12 Tf % (fake) Tj\n<< /X (fake Tj) >> BDC (a\\(b\\)\\101(c)\\\r\nd) Tj <4 1F> Tj EMC ET';
  const {shows,diagnostics}=scanTextShows(input);
  assert.equal(diagnostics.length,0); assert.equal(shows.length,2);
  assert.equal(shows[0].fontName,'F1'); assert.deepEqual(bytes(shows[0].parts[0]),[97,40,98,41,65,40,99,41,100]);
  assert.deepEqual(bytes(shows[1].parts[0]),[0x41,0xf0]);
  for (const show of shows) { assert.equal(input.slice(show.operatorStart,show.operatorEnd),show.kind); assert.equal(input.slice(show.start,show.end).endsWith(show.kind),true); }
  assert.equal(input.slice(shows[1].parts[0].start,shows[1].parts[0].end),'<4 1F>');
});
test('measured advances and TJ spacing respect scaling and line matrix', () => {
  const input='BT /F 10 Tf 50 Tz 1 0 0 1 10 20 Tm [(a) 200 (b)] TJ (x) Tj 5 7 Td (x) Tj ET';
  const {shows,diagnostics}=scanTextShows(input,{measure:()=>4});
  assert.deepEqual(diagnostics,[]); assert.deepEqual(shows.map(s=>s.textMatrix.slice(4)),[[10,20],[13,20],[15,27]]);
  assert.deepEqual(shows[0].parts.map(p=>p.type),['string','adjustment','string']);
  assert.deepEqual(shows[2].lineMatrix.slice(4),[15,27]);
});
test('relative line moves restore known position after unknown show widths', () => {
  const {shows}=scanTextShows('BT /F 8 Tf 1 0 0 1 2 3 Tm (a) Tj (a) Tj 10 -2 Td [(62)] TJ (z) Tj T* (q) Tj ET');
  assert.deepEqual(shows.map(s=>s.uncertain),[false,true,false,true,false]);
  assert.deepEqual(shows[2].textMatrix.slice(4),[12,1]);
  assert.deepEqual(bytes(shows[2].parts[0]),[54,50]);
});
test('graphics transforms and text quotes', () => {
  const {shows}=scanTextShows('q 2 0 0 2 4 5 cm BT /F 10 Tf 12 TL 1 0 0 1 3 4 Tm (a) \' 2 3 (b) " ET Q BT (c) Tj ET',{measure:()=>0});
  assert.deepEqual(shows[0].ctm,[2,0,0,2,4,5]); assert.deepEqual(shows[0].textMatrix.slice(4),[3,-8]);
  assert.deepEqual(shows[1].textMatrix.slice(4),[3,-20]); assert.equal(shows[1].wordSpace,2); assert.equal(shows[1].charSpace,3);
  assert.deepEqual(shows[2].ctm,[1,0,0,1,0,0]);
});
test('malformed and inline image data stop safely', () => {
  for (const input of ['BT (oops', 'BT <xyz> Tj', 'BT [(a) Tj', 'BT BI /W 1 ID (fake) Tj EI (later) Tj']) {
    const {shows,diagnostics}=scanTextShows(input); assert.equal(shows.length,0); assert.ok(diagnostics.length);
  }
  const raw=Uint8Array.from([66,84,32,40,255,41,32,84,106,32,69,84]);
  const {shows}=scanTextShows(raw); assert.deepEqual(bytes(shows[0].parts[0]),[255]); assert.equal(shows[0].start,3);
});

test('unknown state stays uncertain across Tm and is restored by Q', () => {
  const {shows, diagnostics}=scanTextShows('BT q mystery 1 0 0 1 0 0 Tm (x) Tj Q 1 0 0 1 2 3 Tm (y) Tj ET');
  assert.deepEqual(shows.map(s=>s.uncertain),[true,false]);
  assert.match(diagnostics[0].message,/Unknown operator/);
  assert.deepEqual(bytes(scanTextShows('BT (a\r\nb\rc) Tj ET').shows[0].parts[0]),[97,10,98,10,99]);
});
