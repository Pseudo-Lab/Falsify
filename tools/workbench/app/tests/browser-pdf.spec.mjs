import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import http from 'node:http';
import {extname, join, relative as pathRelative, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import * as mupdf from 'mupdf';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {BrowserPdfError, COORDINATE_SPACE, COORDINATES, ENGINE, prepare} from '../dist/browser-pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function streamObj(data) {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from(`<< /Length ${body.length} >> stream\n`), body, Buffer.from('\nendstream')]);
}

function assemble(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = chunks.reduce((n, c) => n + c.length, 0);
    chunks.push(Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n'));
  }
  const start = chunks.reduce((n, c) => n + c.length, 0);
  const count = objects.length - 1;
  let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer << /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(chunks));
}

function buildPdf(pageBodies, {rotate = []} = {}) {
  const font = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const image = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >> stream\n`),
    pixels, Buffer.from('\nendstream'),
  ]);
  const objects = [null];
  const pageIds = [];
  const contentIds = [];
  let next = 3;
  for (let i = 0; i < pageBodies.length; i++) {
    pageIds.push(next++);
    contentIds.push(next++);
  }
  const fontId = next++;
  const imageId = next++;
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${pageBodies.length} >>`);
  pageBodies.forEach((body, index) => {
    const turn = rotate[index] ? ` /Rotate ${rotate[index]}` : '';
    objects[pageIds[index]] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${turn} /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> >>`);
    objects[contentIds[index]] = streamObj(body);
  });
  objects[fontId] = font;
  objects[imageId] = image;
  return assemble(objects);
}

const figure = 'q 1 0 0 RG 2 w 72 500 80 40 re S Q\nq 20 0 0 20 400 480 cm /Im1 Do Q\n';
const multi = buildPdf([
  `BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (Keep alpha REPLACE me and beta.) Tj 1 0 0 1 72 682 Tm (Second line stays.) Tj ET\n${figure}`,
  'BT /F1 12 Tf 0 0 0.7 rg 1 0 0 1 72 700 Tm (Untouched control page figure-text.) Tj ET\nq 0 0.4 0.2 RG 3 w 100 100 60 60 re S Q\n',
]);
const rotated = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 400 Tm (Rotate BEFORE here.) Tj ET\n',
], {rotate: [90]});
const mixedRotation = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (Keep alpha REPLACE me and beta.) Tj ET\n',
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 400 Tm (Rotate BEFORE here.) Tj ET\n',
], {rotate: [0, 90]});
const longPage = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (HOOK) Tj 1 0 0 1 360 700 Tm (BLOCKER stays to the right.) Tj ET\n',
]);
const crowded = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (HOOK) Tj 1 0 0 1 360 700 Tm (BLOCKER stays to the right.) Tj 1 0 0 1 72 686 Tm (Filled line immediately below the hook.) Tj ET\n',
]);
const cafe = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (The caf\\351 table.) Tj ET\n',
]);
const repeated = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (See beta and beta.) Tj ET\n',
]);
const overlap = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (XXXX) Tj ET\n',
]);
const actualText = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg /Span << /ActualText (REPLACE) >> BDC 1 0 0 1 72 700 Tm (XXXXXXX) Tj (.) Tj EMC ET\n',
]);

function fileOf(bytes, name = 'fixture.pdf') {
  return new File([bytes], name, {type: 'application/pdf'});
}
function snapshot(bytes, edits) {
  return {schema: 'falsify.paper-edits.v1', fileHash: sha(bytes), revision: 1, edits};
}
async function bytesOf(file) {
  return new Uint8Array(await file.arrayBuffer());
}
const cMapUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url)) + '/';
async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, cMapUrl, cMapPacked: true}).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
    page.cleanup();
  }
  if (typeof doc.cleanup === 'function') await doc.cleanup();
  return pages;
}
async function operators(bytes, pageNumber) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false}).promise;
  const page = await doc.getPage(pageNumber);
  const list = await page.getOperatorList();
  const names = list.fnArray.map(fn => Object.entries(pdfjs.OPS).find(([, value]) => value === fn)?.[0]);
  if (typeof doc.cleanup === 'function') await doc.cleanup();
  return names;
}
const VISIBLE_STAMPS = [/Falsify/i, /provenance/i, /layoutVerified/, /\battack\b/i, /\bquality\b/i];

function contentStreams(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF();
  try {
    return Array.from({length: doc.countPages()}, (_, index) => {
      const contents = doc.loadPage(index).getObject().get('Contents');
      const parts = [];
      if (contents.isArray()) for (let i = 0; i < contents.length; i++) parts.push(contents.get(i).readStream().asString());
      else parts.push(contents.readStream().asString());
      return parts.join('\n');
    });
  } finally { doc.destroy(); }
}
function annotationTypes(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF();
  try {
    const names = [];
    for (let index = 0; index < doc.countPages(); index++) {
      for (const annot of doc.loadPage(index).getAnnotations()) names.push(annot.getType());
    }
    return names;
  } finally { doc.destroy(); }
}
function assertNoVisibleStamps(streams, texts) {
  const visible = [...streams, ...texts].join('\n');
  for (const pattern of VISIBLE_STAMPS) assert.equal(pattern.test(visible), false, pattern.source);
}
let resolvedPython;
function pythonExecutable() {
  if (resolvedPython !== undefined) return resolvedPython;
  const requested = process.env.PYTHON_EXECUTABLE;
  const candidates = requested ? [requested] : (process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']);
  for (const command of candidates) {
    try {
      execFileSync(command, ['-c', 'import pymupdf'], {stdio: 'ignore'});
      resolvedPython = command;
      return command;
    } catch { /* try the next installed interpreter */ }
  }
  resolvedPython = '';
  return '';
}
function pymupdfAvailable() {
  return Boolean(pythonExecutable());
}
function pymupdfInspect(source, output) {
  const script = `
import base64, json, sys, pymupdf
body = json.load(sys.stdin)
def open_pdf(key):
    return pymupdf.open(stream=base64.b64decode(body[key]), filetype='pdf')
src, out = open_pdf('source'), open_pdf('output')
def pix(doc, index):
    return doc[index].get_pixmap(dpi=72, alpha=False, colorspace=pymupdf.csRGB)
a, b = pix(src, 1), pix(out, 1)
diff = sum(1 for x, y in zip(a.samples, b.samples) if x != y) if a.samples == a.samples and len(a.samples) == len(b.samples) else -1
print(json.dumps({
  'texts': [page.get_text('text') for page in out],
  'pages': [src.page_count, out.page_count],
  'untouchedDiff': diff,
  'untouchedSamples': len(a.samples),
  'version': pymupdf.version[1] if isinstance(pymupdf.version, tuple) else str(pymupdf.version),
}))
`;
  return JSON.parse(execFileSync(pythonExecutable(), ['-c', script], {
    input: JSON.stringify({source: Buffer.from(source).toString('base64'), output: Buffer.from(output).toString('base64')}),
    maxBuffer: 32 * 1024 * 1024,
  }).toString());
}

test('browser-pdf loader lifecycle', () => {
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./browser-pdf-loader.spec.mjs', import.meta.url))], {encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('vendored engine pin and global', () => {
  const manifest = JSON.parse(readFileSync(new URL('../dist/browser-pdf-vendor/manifest.json', import.meta.url), 'utf8'));
  const wasm = readFileSync(new URL('../dist/browser-pdf-vendor/mupdf-wasm.wasm', import.meta.url));
  assert.equal(manifest.version, '1.28.1');
  assert.equal(manifest.license, 'AGPL-3.0-or-later');
  assert.equal(manifest.files['mupdf-wasm.wasm'].sha256, sha(wasm));
  assert.equal(ENGINE.version, '1.28.1');
  assert.equal(COORDINATE_SPACE, 'top-left-page');
  assert.deepEqual(COORDINATES, {space: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt'});
  assert.equal(globalThis.FalsifyBrowserPdf.COORDINATE_SPACE, COORDINATE_SPACE);
  assert.equal(typeof globalThis.FalsifyBrowserPdf.prepare, 'function');
  const loader = readFileSync(new URL('../dist/browser-pdf.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../dist/browser-pdf-worker.mjs', import.meta.url), 'utf8');
  assert.match(loader, /FalsifyBrowserPdf/);
  assert.match(loader, /browser-pdf-worker\.mjs/);
  assert.match(loader, /terminate\(/);
  assert.match(loader, /id: id/);
  assert.equal(loader.includes("import(new URL('./browser-pdf.mjs'"), false);
  assert.match(worker, /new URL\('\.\/browser-pdf\.mjs', import\.meta\.url\)/);
  assert.match(worker, /\[copy\]/);
  assert.match(readFileSync(new URL('../dist/browser-pdf-vendor/NOTICE.md', import.meta.url), 'utf8'), /AGPL/);
});

test('replaces one word, keeps unrelated text, figures, and page count', async () => {
  const result = await prepare({
    file: fileOf(multi, 'paper.pdf'),
    edits: snapshot(multi, [
      {id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {coordinateSpace: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt', bbox: [120, 60, 210, 110]}},
      {id: 'same', enabled: true, pageIndex: 0, before: 'line', after: 'line', origin: 'human'},
      {id: 'off', enabled: false, pageIndex: 0, before: 'alpha', after: 'zzzz', origin: 'human'},
    ]),
    signal: new AbortController().signal,
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.notEqual(result.sha256, sha(multi));
  assert.equal(result.file.name, 'paper.edited.pdf');
  assert.equal(result.file.type, 'application/pdf');
  assert.equal(String.fromCharCode(...out.slice(0, 5)), '%PDF-');
  assert.equal(result.pageMap.length, 2);
  assert.deepEqual(result.pageMap[0], {
    sourcePageIndex: 0, outputPageIndex: 0, continuationPageIndices: [],
    coordinateSpace: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt',
    width: 612, height: 792, rotation: 0,
  });
  assert.deepEqual(result.pageMap[1], {
    sourcePageIndex: 1, outputPageIndex: 1, continuationPageIndices: [],
    coordinateSpace: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt',
    width: 612, height: 792, rotation: 0,
  });
  assert.equal(result.verification.coordinateSpace, 'top-left-page');
  assert.equal(result.verification.pages[0].editable, true);
  assert.equal(result.verification.pages[0].width, 612);
  assert.equal(result.verification.pages[0].height, 792);
  assert.equal(result.verification.pages[0].rotation, 0);
  assert.equal(result.verification.status, 'applied');
  assert.equal(result.verification.independent, false);
  assert.equal(result.verification.edits.every(edit => edit.status === 'applied'), true);
  const word = result.verification.edits.find(edit => edit.id === 'word');
  assert.equal(word.font, 'Helvetica');
  assert.equal(word.size, 12);
  assert.deepEqual(word.color, [0, 0, 0]);
  assert.equal(word.fontSubstituted, false);
  const streams = contentStreams(out);
  assert.equal(streams[0].includes('REPLACE'), false);
  assert.equal(streams[0].includes('(AFTER)'), true);
  assert.equal(streams[0].includes('alpha'), true);
  assert.equal(streams[0].includes('Second'), true);
  assert.match(streams[0], /\/Im1\s+Do/);
  assert.match(streams[0], /\bre\b/);
  assert.equal(streams[1].includes('Untouched control page figure-text'), true);
  const pages = await pdfText(out);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].includes('REPLACE'), false);
  assert.equal(pages[0].includes('AFTER'), true);
  assert.equal(pages[0].includes('alpha'), true);
  assert.equal(pages[0].includes('beta'), true);
  assert.equal(pages[0].includes('Second'), true);
  assert.equal(pages[0].includes('zzzz'), false);
  assert.equal(pages[1].includes('Untouched control page figure-text'), true);
  assertNoVisibleStamps(streams, pages);
  assert.deepEqual(annotationTypes(out), []);
  const ops = await operators(out, 1);
  assert.ok(ops.includes('rectangle') || ops.includes('constructPath'), ops.filter(Boolean).join(','));
  assert.ok(ops.some(name => /paintImage|paintXObject/.test(name || '')), ops.filter(Boolean).join(','));
  const other = await operators(out, 2);
  assert.ok(other.includes('rectangle') || other.includes('constructPath'), other.filter(Boolean).join(','));
});

test('pymupdf extraction and untouched-page render when installed', async (t) => {
  if (!pymupdfAvailable()) {
    t.skip('pymupdf is not importable; set PYTHON_EXECUTABLE');
    return;
  }
  const result = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
  });
  const report = pymupdfInspect(multi, await bytesOf(result.file));
  assert.equal(report.pages[0], report.pages[1]);
  assert.equal(report.texts[0].includes('REPLACE'), false);
  assert.equal(report.texts[0].includes('AFTER'), true);
  assert.equal(report.texts[1].includes('Untouched control page figure-text'), true);
  assert.ok(report.untouchedSamples > 0);
  assert.ok(report.untouchedDiff / report.untouchedSamples < 0.002, `untouched raster diff ${report.untouchedDiff}/${report.untouchedSamples} pymupdf ${report.version}`);
});

test('wraps a long After when the line below is free', async () => {
  const after = 'This replacement is intentionally long so the browser editor wraps it onto the open lines below.';
  const result = await prepare({
    file: fileOf(longPage),
    edits: snapshot(longPage, [{id: 'long', pageIndex: 0, before: 'HOOK', after, origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  const edit = result.verification.edits[0];
  assert.ok(edit.wrappedLines >= 2, 'wrappedLines ' + edit.wrappedLines);
  const text = (await pdfText(out))[0];
  assert.equal(text.includes('HOOK'), false);
  assert.equal(text.includes('BLOCKER'), true);
  assert.equal(text.includes('intentionally'), true);
  assert.equal(text.includes('open'), true);
  assert.equal(contentStreams(out)[0].includes('HOOK'), false);
  assert.equal(result.pageMap.length, 1);
});

test('refuses a long After that would cover the next line', async () => {
  const after = 'This replacement is intentionally long so the browser editor wraps it onto the open lines below.';
  await assert.rejects(() => prepare({
    file: fileOf(crowded),
    edits: snapshot(crowded, [{id: 'long', pageIndex: 0, before: 'HOOK', after, origin: 'human'}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'long-after-no-room');
});

test('WinAnsi Latin and Korean CJK replacement', async () => {
  const result = await prepare({
    file: fileOf(cafe),
    edits: snapshot(cafe, [{id: 'cafe', pageIndex: 0, before: 'café', after: 'naïve', origin: 'human'}]),
  });
  const text = (await pdfText(await bytesOf(result.file)))[0];
  assert.equal(text.includes('café'), false);
  assert.equal(text.includes('naïve'), true);
  assert.equal(text.includes('table'), true);
  const korean = await prepare({
    file: fileOf(cafe),
    edits: snapshot(cafe, [{id: 'hangul', pageIndex: 0, before: 'table', after: '한글', origin: 'human'}]),
  });
  const koreanBytes = await bytesOf(korean.file);
  assert.equal(korean.sha256, sha(koreanBytes));
  assert.notEqual(korean.sha256, sha(cafe));
  const koreanText = (await pdfText(koreanBytes))[0];
  assert.equal(koreanText.includes('table'), false);
  assert.equal(koreanText.includes('한글'), true);
  assert.equal(koreanText.includes('café'), true);
  const koreanStream = contentStreams(koreanBytes)[0];
  assert.equal(koreanStream.includes('table'), false);
  assert.match(koreanStream, /<d55cae00> Tj/);
  assert.equal(korean.verification.edits[0].encoding, 'uniks-utf16');
  assert.equal(korean.verification.edits[0].fontSubstituted, true);
  assert.equal(korean.verification.edits[0].status, 'applied');
  assert.equal(korean.verification.status, 'warning');
  assert.equal(korean.verification.layoutVerified, false);
  assert.ok(korean.warnings.some(item => item.code === 'font-substituted'));
  let extracted = '';
  const opened = mupdf.Document.openDocument(new Uint8Array(koreanBytes), 'application/pdf');
  try { opened.loadPage(0).toStructuredText('preserve-whitespace').walk({onChar(ch) { extracted += ch; }}); }
  finally { opened.destroy(); }
  assert.equal(extracted.includes('한글'), true);
});

test('top-left bbox edits and a bottom-left bbox does not', async () => {
  const top = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: [136, 79, 193, 96]}}]),
  });
  const topText = (await pdfText(await bytesOf(top.file)))[0];
  assert.equal(topText.includes('REPLACE'), false);
  assert.equal(topText.includes('AFTER'), true);
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: [120, 690, 210, 720]}}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'anchor-mismatch' && error.details.coordinateSpace === 'top-left-page' && error.details.pages[0].origin === 'top-left' && error.details.pages[0].yAxis === 'down');
  for (const anchor of [
    {coordinateSpace: 'bottom-left', bbox: [120, 690, 210, 720]},
    {origin: 'bottom-left', bbox: [136, 79, 193, 96]},
    {yAxis: 'up', bbox: [136, 79, 193, 96]},
  ]) {
    await assert.rejects(() => prepare({
      file: fileOf(multi),
      edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor}]),
    }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'invalid-anchor');
  }
});

test('rotated page is rejected and the source is not returned', async () => {
  await assert.rejects(() => prepare({
    file: fileOf(rotated),
    edits: snapshot(rotated, [{id: 'turn', pageIndex: 0, before: 'BEFORE', after: 'AFTER', origin: 'human', anchor: {bbox: [120, 60, 210, 110]}}]),
  }), error => {
    assert.ok(error instanceof BrowserPdfError);
    assert.equal(error.code, 'unsupported');
    assert.equal(error.file, undefined);
    assert.equal(error.details.edits[0].code, 'rotated-page');
    assert.equal(error.details.coordinateSpace, 'top-left-page');
    assert.deepEqual(error.details.pages[0], {
      pageIndex: 0, coordinateSpace: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt',
      width: 792, height: 612, rotation: 90, editable: false,
    });
    return true;
  });
});

test('an unrotated page can change while a rotated page stays untouched', async () => {
  const result = await prepare({
    file: fileOf(mixedRotation),
    edits: snapshot(mixedRotation, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: [120, 60, 210, 110]}}]),
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.notEqual(result.sha256, sha(mixedRotation));
  assert.equal(result.pageMap[0].rotation, 0);
  assert.equal(result.pageMap[0].width, 612);
  assert.equal(result.pageMap[0].height, 792);
  assert.equal(result.verification.pages[0].editable, true);
  assert.equal(result.pageMap[1].rotation, 90);
  assert.equal(result.pageMap[1].width, 792);
  assert.equal(result.pageMap[1].height, 612);
  assert.equal(result.verification.pages[1].editable, false);
  const pages = await pdfText(out);
  assert.equal(pages[0].includes('AFTER'), true);
  assert.equal(pages[0].includes('REPLACE'), false);
  assert.equal(pages[1].includes('BEFORE'), true);
  assert.equal(pages[1].includes('AFTER'), false);
  assertNoVisibleStamps(contentStreams(out), pages);
});

test('page occurrence precedes bbox filtering and bounded font drift stays a warning', async () => {
  const doc = mupdf.Document.openDocument(new Uint8Array(repeated), 'application/pdf');
  const chars = [];
  try { doc.loadPage(0).toStructuredText('preserve-whitespace').walk({onChar(ch, origin, font, size, quad) { chars.push({ch, quad, origin: [...origin]}); }}); }
  finally { doc.destroy(); }
  const text = chars.map(c => c.ch).join('');
  const start = text.indexOf('beta', text.indexOf('beta') + 1);
  const points = chars.slice(start, start + 4).flatMap(c => [0, 2, 4, 6].map(i => [c.quad[i], c.quad[i + 1]]));
  const box = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  const edit = {id: 'second', pageIndex: 0, before: 'beta', after: 'B', origin: 'human', anchor: {occurrence: 1, bbox: box}};
  const result = await prepare({file: fileOf(repeated), edits: snapshot(repeated, [edit])});
  const outputBytes = await bytesOf(result.file);
  const extracted = (await pdfText(outputBytes))[0];
  assert.equal((extracted.match(/beta/g) || []).length, 1);
  assert.ok(extracted.includes('See beta and') && extracted.includes('B'));
  const output = mupdf.Document.openDocument(outputBytes, 'application/pdf');
  let placed;
  try { output.loadPage(0).toStructuredText('preserve-whitespace').walk({onChar(ch, origin) { if (ch === 'B') placed = [...origin]; }}); }
  finally { output.destroy(); }
  assert.ok(placed && Math.abs(placed[0] - chars[start].origin[0]) < 0.02 && Math.abs(placed[1] - chars[start].origin[1]) < 0.02);
  const shifted = [box[0] + 5, box[1], box[2] + 5, box[3]];
  const drift = await prepare({file: fileOf(repeated), edits: snapshot(repeated, [{...edit, anchor: {occurrence: 1, bbox: shifted}}])});
  assert.ok(drift.warnings.some(w => w.code === 'selection-font-metrics'));
  assert.equal(drift.verification.layoutVerified, false);
  await assert.rejects(prepare({file: fileOf(repeated), edits: snapshot(repeated, [{...edit, anchor: {occurrence: 0, bbox: box}}])}), e => e.details?.edits?.[0]?.code === 'anchor-mismatch');
});

test('raw segment offsets do not choose a page hit', async () => {
  const ignored = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {start: 0, end: 7}}]),
  });
  const ignoredText = (await pdfText(await bytesOf(ignored.file)))[0];
  assert.equal(ignoredText.includes('REPLACE'), false);
  assert.equal(ignoredText.includes('AFTER'), true);
  await assert.rejects(() => prepare({
    file: fileOf(repeated),
    edits: snapshot(repeated, [{id: 'dup', pageIndex: 0, before: 'beta', after: 'BETA', origin: 'human', anchor: {start: 13, end: 17}}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'ambiguous');
});

test('overlapping hits stay ambiguous until occurrence is set', async () => {
  await assert.rejects(() => prepare({
    file: fileOf(overlap),
    edits: snapshot(overlap, [{id: 'over', pageIndex: 0, before: 'XXX', after: 'YY', origin: 'human'}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'ambiguous');
  const picked = await prepare({
    file: fileOf(overlap),
    edits: snapshot(overlap, [{id: 'over', pageIndex: 0, before: 'XXX', after: 'YY', origin: 'human', anchor: {occurrence: 0}}]),
  });
  const out = await bytesOf(picked.file);
  assert.equal(picked.sha256, sha(out));
  assert.equal(String.fromCharCode(...out.slice(0, 5)), '%PDF-');
  assert.equal((await pdfText(out))[0].includes('XXXX'), false);
});

test('empty After deletes the matched text', async () => {
  const result = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'gone', pageIndex: 0, before: 'REPLACE', after: '', origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.notEqual(result.sha256, sha(multi));
  assert.equal(result.verification.status, 'applied');
  const text = (await pdfText(out))[0];
  assert.equal(text.includes('REPLACE'), false);
  assert.equal(text.includes('AFTER'), false);
  assert.equal(text.includes('alpha'), true);
  assert.equal(contentStreams(out)[0].includes('REPLACE'), false);
});

test('exact top-left unrotated coordinates', async () => {
  const doc = mupdf.Document.openDocument(new Uint8Array(multi), 'application/pdf');
  let box;
  try {
    const chars = [];
    doc.loadPage(0).toStructuredText('preserve-whitespace').walk({onChar(ch, _origin, _font, _size, quad) { chars.push({ch, quad: [...quad]}); }});
    const at = chars.map(item => item.ch).join('').indexOf('REPLACE');
    const slice = chars.slice(at, at + 'REPLACE'.length);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const item of slice) for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, item.quad[i]); y0 = Math.min(y0, item.quad[i + 1]);
      x1 = Math.max(x1, item.quad[i]); y1 = Math.max(y1, item.quad[i + 1]);
    }
    box = [x0, y0, x1, y1];
  } finally { doc.destroy(); }
  assert.ok(box[1] > 70 && box[3] < 110, 'top-left y ' + box.join(','));
  assert.ok(box[0] > 120 && box[2] < 210, 'top-left x ' + box.join(','));
  const edited = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: box}}]),
  });
  assert.equal(edited.pageMap[0].coordinateSpace, 'top-left-page');
  assert.equal(edited.pageMap[0].rotation, 0);
  assert.equal(edited.pageMap[0].width, 612);
  assert.equal(edited.pageMap[0].height, 792);
  assert.equal((await pdfText(await bytesOf(edited.file)))[0].includes('AFTER'), true);
  const shifted = [box[0], box[1] + 600, box[2], box[3] + 600];
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: shifted}}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'anchor-mismatch');
});

test('a failed check still returns the same parseable PDF and hash', async () => {
  const result = await prepare({
    file: fileOf(actualText),
    edits: snapshot(actualText, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  const again = await bytesOf(result.file);
  assert.equal(result.verification.status, 'failed');
  assert.equal(result.verification.layoutVerified, false);
  assert.equal(result.verification.edits[0].status, 'failed');
  assert.equal(result.verification.edits[0].checks[0].code, 'removed-before');
  assert.equal(result.verification.quality.removedBefore, false);
  assert.notEqual(result.verification.status, 'applied');
  assert.equal(result.sha256, sha(out));
  assert.equal(result.verification.outputSha256, sha(again));
  assert.equal(sha(out), sha(again));
  assert.equal(String.fromCharCode(...out.slice(0, 5)), '%PDF-');
  const opened = mupdf.Document.openDocument(new Uint8Array(out), 'application/pdf');
  let extracted = '';
  try {
    assert.equal(opened.countPages(), 1);
    opened.loadPage(0).toStructuredText('preserve-whitespace').walk({onChar(ch) { extracted += ch; }});
  } finally { opened.destroy(); }
  const text = (await pdfText(out))[0];
  assert.equal(text.includes('AFTER'), true);
  assert.equal(extracted.includes('AFTER'), true);
  assert.equal(extracted.includes('REPLACE'), true);
});

test('ambiguous, stale, and aborted requests do not return a file', async () => {
  await assert.rejects(() => prepare({
    file: fileOf(repeated),
    edits: snapshot(repeated, [{id: 'dup', pageIndex: 0, before: 'beta', after: 'BETA', origin: 'human'}]),
  }), error => error.code === 'unsupported' && error.details.edits[0].code === 'ambiguous');
  const picked = await prepare({
    file: fileOf(repeated),
    edits: snapshot(repeated, [{id: 'dup', pageIndex: 0, before: 'beta', after: 'BETA', origin: 'human', anchor: {occurrence: 1}}]),
  });
  const pickedText = (await pdfText(await bytesOf(picked.file)))[0];
  assert.equal(pickedText.includes('BETA'), true);
  assert.equal(pickedText.includes('beta'), true);
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
    fileHash: '0'.repeat(64),
  }), error => error.code === 'stale-source');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
    signal: controller.signal,
  }), error => error.code === 'aborted');
});

function browserExecutable() {
  if (process.env.BROWSER_EXECUTABLE) return process.env.BROWSER_EXECUTABLE;
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
  }
  return candidates.find(candidate => existsSync(candidate)) || '';
}

function listen(root) {
  const types = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json'};
  const hits = [];
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    hits.push(pathname);
    const relative = pathname.replace(/^\/+/, '');
    if (relative === 'harness.html') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><title>browser-pdf</title><script src="/dist/browser-pdf.js"></script>');
      return;
    }
    const path = join(root, relative);
    const fromRoot = pathRelative(root, path);
    if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) { res.writeHead(403); res.end(); return; }
    try {
      const body = readFileSync(path);
      res.writeHead(200, {'content-type': types[extname(path)] || 'application/octet-stream'});
      res.end(body);
    } catch { res.writeHead(404); res.end('missing'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { server.hits = hits; resolve(server); }));
}

test('chrome classic loader runs the vendored WASM edit', async (t) => {
  let chromium;
  try { ({chromium} = await import('playwright')); }
  catch { t.skip('playwright is not installed'); return; }
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('browser executable not found; set BROWSER_EXECUTABLE');
    return;
  }
  const server = await listen(fileURLToPath(new URL('..', import.meta.url)));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/harness.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => globalThis.FalsifyBrowserPdf && typeof globalThis.FalsifyBrowserPdf.prepare === 'function');
    const before = server.hits.filter(path => /wasm|browser-pdf\.mjs|browser-pdf-worker/.test(path));
    assert.deepEqual(before, []);
    const encoded = Buffer.from(multi).toString('base64');
    const produced = await Promise.race([
      page.evaluate(async (b64) => {
      const workers = [];
      let nextPost = null;
      const NativeWorker = window.Worker;
      window.Worker = function (...args) {
        const worker = new NativeWorker(...args);
        const record = {terminated: false};
        const stop = worker.terminate.bind(worker);
        worker.terminate = () => { record.terminated = true; return stop(); };
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...message) => {
          post(...message);
          if (nextPost) { const ready = nextPost; nextPost = null; ready(); }
        };
        workers.push(record);
        return worker;
      };
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const kept = bytes.slice();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const fileHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const early = new AbortController();
      early.abort();
      let earlyCode = '';
      try {
        await FalsifyBrowserPdf.prepare({
          file: new File([bytes], 'paper.pdf', {type: 'application/pdf'}),
          edits: {schema: 'falsify.paper-edits.v1', fileHash, edits: [{id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]},
          signal: early.signal,
        });
      } catch (error) { earlyCode = error.code; }
      const file = new File([bytes], 'paper.pdf', {type: 'application/pdf'});
      const result = await FalsifyBrowserPdf.prepare({
        file,
        edits: {schema: 'falsify.paper-edits.v1', fileHash, edits: [{id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]},
      });
      const sourceStill = bytes.length === kept.length && bytes.every((value, index) => value === kept[index]);
      const controller = new AbortController();
      const posted = new Promise(resolve => { nextPost = resolve; });
      const cancelled = FalsifyBrowserPdf.prepare({
        file,
        edits: {schema: 'falsify.paper-edits.v1', fileHash, edits: [{id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]},
        signal: controller.signal,
      });
      await posted;
      controller.abort();
      let cancelCode = '';
      try { await cancelled; } catch (error) { cancelCode = error.code; }
      const again = await FalsifyBrowserPdf.prepare({
        file,
        edits: {schema: 'falsify.paper-edits.v1', fileHash, edits: [{id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'LATER', origin: 'human'}]},
      });
      const out = new Uint8Array(await result.file.arrayBuffer());
      let text = '';
      for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
      const later = new Uint8Array(await again.file.arrayBuffer());
      return {
        b64: btoa(text), sha256: result.sha256, status: result.verification.status, pages: result.pageMap.length, head: text.slice(0, 5),
        coordinateSpace: result.pageMap[0].coordinateSpace, origin: result.pageMap[0].origin, yAxis: result.pageMap[0].yAxis,
        width: result.pageMap[0].width, height: result.pageMap[0].height, rotation: result.pageMap[0].rotation,
        earlyCode, cancelCode, workers: workers.length, terminated: workers.filter(item => item.terminated).length,
        sourceStill, laterStatus: again.verification.status, laterHasLater: new TextDecoder('latin1').decode(later).includes('(LATER)'),
      };
    }, encoded),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('browser prepare timed out ' + server.hits.join(' | '))), 20000)),
    ]);
    assert.deepEqual(errors, []);
    assert.equal(produced.status, 'applied');
    assert.equal(produced.pages, 2);
    assert.equal(produced.coordinateSpace, 'top-left-page');
    assert.equal(produced.origin, 'top-left');
    assert.equal(produced.yAxis, 'down');
    assert.equal(produced.width, 612);
    assert.equal(produced.height, 792);
    assert.equal(produced.rotation, 0);
    assert.equal(produced.head, '%PDF-');
    assert.equal(produced.earlyCode, 'aborted');
    assert.equal(produced.cancelCode, 'aborted');
    assert.equal(produced.sourceStill, true);
    assert.ok(produced.workers >= 2, 'workers ' + produced.workers);
    assert.ok(produced.terminated >= 1, 'terminated ' + produced.terminated);
    assert.equal(produced.laterStatus, 'applied');
    assert.equal(produced.laterHasLater, true);
    assert.ok(server.hits.some(path => path.endsWith('browser-pdf-worker.mjs')));
    assert.ok(server.hits.some(path => path.endsWith('mupdf-wasm.wasm')));
    const out = Uint8Array.from(Buffer.from(produced.b64, 'base64'));
    assert.equal(produced.sha256, sha(out));
    const stream = contentStreams(out)[0];
    assert.equal(stream.includes('REPLACE'), false);
    assert.equal(stream.includes('(AFTER)'), true);
    assert.match(stream, /\/Im1\s+Do/);
  } catch (error) {
    if (/Executable doesn't exist|Failed to launch/i.test(String(error))) {
      t.skip(String(error));
      return;
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('output hash is the returned bytes and quality warnings still return a candidate', async () => {
  const result = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.equal(result.verification.outputSha256, result.sha256);
  assert.equal(result.verification.sourceSha256, sha(multi));
  assert.ok(result.warnings.some(item => item.code === 'extraction-gap'));
  assert.equal(result.verification.quality.removedBefore, true);
  assert.equal(result.verification.quality.presentAfter, true);
  assert.equal((await pdfText(out))[0].includes('AFTER'), true);
});
