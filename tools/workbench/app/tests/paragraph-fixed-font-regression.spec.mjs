import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import * as paragraphPdf from '../dist/paragraph-pdf.mjs';

// Two distinct standard-font resources occur after a table-cell replacement:
// the new cell has WinAnsi encoding while the original page uses Helvetica.
function fixture(font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>') {
  const content = `BT /F1 8 Tf 50 467 Td (Group) Tj ET
BT /F2 8 Tf 170 447 Td (11) Tj ET
BT /F1 10 Tf 40 300 Td (Original body paragraph stays lower on the page.) Tj ET\n`;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    font,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

function embeddedCollision() {
  const doc = new mupdf.PDFDocument();
  const fonts = ['Regular', 'Bold'].map(style => {
    const bytes = readFileSync(new URL(`../dist/font-assets/LiberationSerif-${style}.ttf`, import.meta.url));
    const font = new mupdf.Font(`fixture-${style}`, bytes);
    try { return doc.addSimpleFont(font); } finally { font.destroy(); }
  });
  try {
    for (const font of fonts) {
      font.put('BaseFont', 'SharedFixture');
      font.get('FontDescriptor').put('FontName', 'SharedFixture');
    }
    const bodyFont = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    const content = 'BT /F1 14 Tf 50 420 Td (Collision sample Regular) Tj ET\n' +
      'BT /F2 14 Tf 50 360 Td (Collision sample Bold) Tj ET\n' +
      'BT /F3 10 Tf 40 300 Td (Original body paragraph stays lower on the page.) Tj ET\n';
    doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {Font: {F1: fonts[0], F2: fonts[1], F3: bodyFont}}, content));
    const buffer = doc.saveToBuffer();
    try { return buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
  } finally { doc.destroy(); }
}

async function edit(bytes) {
  return paragraphPdf.prepare({file: new File([bytes], 'fixture.pdf'),
    fileHash: createHash('sha256').update(bytes).digest('hex'), edits: [{id: 'body', pageIndex: 0,
      before: 'Original body paragraph stays lower on the page.', after: 'Changed body paragraph stays lower on the page.'}]});
}

function inspect(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0), structured = page.toStructuredText(), lines = [];
  try {
    structured.walk({beginLine(box) { lines.push({box, text: ''}); }, onChar(c) { lines.at(-1).text += c; }});
    const pix = page.toPixmap([3, 0, 0, 3, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const samples = pix.getPixels(), stride = pix.getStride(), width = pix.getWidth();
      // Compare only the upper 180 PDF points, away from the edited body.
      return {lines, top: Uint8Array.from(samples.subarray(0, stride * 540)), width, stride};
    } finally { pix.destroy(); }
  } finally { structured.destroy(); page.destroy(); doc.destroy(); }
}

function embeddedFonts(bytes) {
  const doc = new mupdf.PDFDocument(bytes), found = [];
  try {
    doc.findPage(0).get('Resources', 'Font').forEach(font => {
      const stream = font.get('FontDescriptor', 'FontFile2');
      if (stream.isNull()) return;
      const buffer = stream.readStream();
      try { found.push({name: font.get('BaseFont').asName(), hash: createHash('sha256').update(buffer.asUint8Array()).digest('hex')}); }
      finally { buffer.destroy(); }
    });
    return found;
  } finally { doc.destroy(); }
}

test('body resize preserves fixed text using a second Helvetica resource', {timeout: 120000}, async () => {
  const bytes = fixture(), savedFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const u = new URL(input);
    if (u.protocol === 'file:') { const {readFileSync} = await import('node:fs'); return new Response(readFileSync(u)); }
    return savedFetch(input);
  };
  try {
    const out = await edit(bytes);
    const before = inspect(bytes), after = inspect(new Uint8Array(await out.file.arrayBuffer()));
    assert.match(after.lines.map(line => line.text).join(' '), /Changed body paragraph stays lower on the page\./);
    assert.deepEqual(after.lines.find(line => line.text === '11'), before.lines.find(line => line.text === '11'));
    assert.equal(after.width, before.width); assert.equal(after.stride, before.stride);
    assert.deepEqual(after.top, before.top);
  } finally { globalThis.fetch = savedFetch; }
});

test('a real embedded font collision preserves both distinct glyphs', {timeout: 120000}, async () => {
  const bytes = embeddedCollision(), savedFetch = globalThis.fetch;
  globalThis.fetch = async input => { const u = new URL(input); return u.protocol === 'file:' ? new Response(readFileSync(u)) : savedFetch(input); };
  try {
    const out = await edit(bytes), output = new Uint8Array(await out.file.arrayBuffer()), before = inspect(bytes), after = inspect(output);
    const sourceFonts = embeddedFonts(bytes), outputFonts = embeddedFonts(output);
    assert.equal(sourceFonts.length, 2);
    for (const font of sourceFonts) assert.ok(outputFonts.some(result => result.hash === font.hash));
    assert.ok(outputFonts.some(font => /^ECAAAA\+SharedFixture-EC/.test(font.name)), 'distinct embedded collision should still be dealiased');
    for (const text of ['Collision sample Regular', 'Collision sample Bold']) {
      const source = before.lines.find(line => line.text === text), result = after.lines.find(line => line.text === text);
      assert.ok(source); assert.ok(result);
      for (let i = 0; i < 4; i++) assert.ok(Math.abs(source.box[i] - result.box[i]) < 0.01);
    }
    assert.deepEqual(after.top, before.top);
    assert.match(after.lines.map(line => line.text).join(' '), /Changed body paragraph stays lower on the page\./);
  } finally { globalThis.fetch = savedFetch; }
});

test('custom Helvetica encoding is not treated as standard digits', {timeout: 120000}, async () => {
  const bytes = fixture('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [49 /A] >> >>');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async input => { const u = new URL(input); return u.protocol === 'file:' ? new Response(readFileSync(u)) : savedFetch(input); };
  try {
    const out = await edit(bytes), before = inspect(bytes), after = inspect(new Uint8Array(await out.file.arrayBuffer()));
    assert.deepEqual(after.lines.find(line => line.text === 'AA'), before.lines.find(line => line.text === 'AA'));
    assert.deepEqual(after.top, before.top);
  } finally { globalThis.fetch = savedFetch; }
});

test('custom-width collision cannot be reported successful with changed fixed text', {timeout: 120000}, async () => {
  const bytes = fixture('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 49 /LastChar 49 /Widths [900] >>');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async input => { const u = new URL(input); return u.protocol === 'file:' ? new Response(readFileSync(u)) : savedFetch(input); };
  try {
    const out = await edit(bytes), before = inspect(bytes), after = inspect(new Uint8Array(await out.file.arrayBuffer()));
    assert.match(after.lines.map(line => line.text).join(' '), /Changed body paragraph stays lower on the page\./);
    if (out.verification.status !== 'failed') {
      assert.deepEqual(after.lines.find(line => line.text === '11'), before.lines.find(line => line.text === '11'));
      assert.deepEqual(after.top, before.top);
    } else {
      assert.ok(out.verification.checks.length, 'a draft must report the reason it was not accepted');
    }
  } finally { globalThis.fetch = savedFetch; }
});
