import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createLayoutPreviewController, createBoundedDocumentCache} from '../src/paper-layout-preview.mjs';

const require = createRequire(import.meta.url);
const enc = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');

async function pdfInput(label) {
  const pdfBytes = enc.encode(`%PDF-fake ${label}`);
  return {pdfBytes, pdfHash: await sha(pdfBytes)};
}

class CancelledRender extends Error { constructor() { super('cancelled'); this.name = 'RenderingCancelledException'; } }

// Fake PDF.js world: documents keyed by the label inside their bytes.
function world({pages = {}, manualRender = false, manualLoad = false, ignoreCancel = false, failLoad = new Set()} = {}) {
  const log = {loads: [], getPage: [], renders: [], cancelled: 0, cleanup: 0, destroyed: [], textCalls: 0};
  const pendingRenders = [], pendingLoads = [];
  const docs = new Map();
  function makeDoc(label) {
    const numPages = pages[label] ?? 3;
    return {
      label, numPages,
      async getPage(n) {
        log.getPage.push(`${label}:${n}`);
        if (!Number.isInteger(n) || n < 1 || n > numPages) throw new Error(`getPage out of range ${label}:${n}`);
        return {
          getViewport: ({scale}) => ({width: 100 * scale, height: 140 * scale, scale}),
          render({canvasContext, viewport}) {
            const content = `${label}:${n - 1}`;
            log.renders.push(content);
            const d = defer();
            let done = false;
            const finish = () => { if (done) return; done = true; canvasContext.canvas.content = content; d.resolve(); };
            const task = {
              promise: d.promise,
              cancel() { log.cancelled++; if (ignoreCancel || done) return; done = true; d.reject(new CancelledRender()); },
              finish, content, viewport,
            };
            if (manualRender) pendingRenders.push(task); else setImmediate(finish);
            return task;
          },
          async getTextContent() { log.textCalls++; return {items: [{str: `${label} page ${n}`, hasEOL: true}, {str: 'second', hasEOL: false}, {str: ' line'}]}; },
          cleanup() { log.cleanup++; },
        };
      },
      destroy() { log.destroyed.push(label); },
    };
  }
  function loadPdf(bytes) {
    const label = new TextDecoder().decode(bytes).replace('%PDF-fake ', '');
    log.loads.push(label);
    const d = defer();
    const task = {promise: d.promise, destroy() { log.destroyed.push(`task:${label}`); d.reject(new Error('destroyed')); }};
    const settle = () => { if (failLoad.has(label)) d.reject(new Error(`cannot open ${label}`)); else { const doc = makeDoc(label); docs.set(label, doc); d.resolve(doc); } };
    if (manualLoad) pendingLoads.push({label, settle}); else setImmediate(settle);
    return task;
  }
  return {log, loadPdf, pendingRenders, pendingLoads, docs};
}

function fakeCanvas(name) {
  const canvas = {name, width: 0, height: 0, dataset: {}, content: null, draws: 0,
    getContext() { return {canvas, drawImage(src) { canvas.content = src.content; canvas.draws++; }}; }};
  return canvas;
}
function fakeDoc() {
  const created = [];
  return {created, createElement(tag) { assert.equal(tag, 'canvas'); const c = fakeCanvas('scratch'); created.push(c); return c; }};
}

function harness(options = {}, worldOptions = {}) {
  const w = world(worldOptions);
  const originalCanvas = fakeCanvas('original'), candidateCanvas = fakeCanvas('candidate');
  const events = {status: [], page: [], text: []};
  const doc = fakeDoc();
  const controller = createLayoutPreviewController({
    doc, originalCanvas, candidateCanvas, loadPdf: w.loadPdf,
    cacheFactory: options.cacheFactory ?? (o => createBoundedDocumentCache(o)),
    onStatus: s => events.status.push(s), onPage: p => events.page.push(p), onText: t => events.text.push(t),
    ...options.extra,
  });
  return {w, controller, originalCanvas, candidateCanvas, events, doc};
}

test('rapid 20-step navigation cancels real render tasks and paints only the last independent pages', async () => {
  const {w, controller, originalCanvas, candidateCanvas, events} = harness({}, {manualRender: true, pages: {orig: 4, cand: 6}});
  await controller.setDocuments({original: await pdfInput('orig'), candidate: await pdfInput('cand')});
  const results = [];
  for (let i = 0; i < 20; i++) {
    results.push(controller.show({originalPageIndex: i % 4, candidatePageIndex: (i * 7) % 6}));
    await ticks();
    assert.equal(w.pendingRenders.length, 2 * (i + 1), `request ${i} started rendering both sides`);
  }
  // Complete every render, including the cancelled ones that ignore nothing.
  for (const task of w.pendingRenders) task.finish();
  const settled = await Promise.all(results);
  assert.deepEqual(settled.slice(0, 19).map(r => r.status), Array(19).fill('cancelled'));
  const last = settled[19];
  assert.equal(last.status, 'ready');
  assert.equal(last.originalPageIndex, 19 % 4);
  assert.equal(last.candidatePageIndex, (19 * 7) % 6);
  assert.equal(originalCanvas.content, `orig:${19 % 4}`);
  assert.equal(candidateCanvas.content, `cand:${(19 * 7) % 6}`);
  const stats = controller.getStats();
  assert.equal(stats.documentLoads, 2);
  assert.equal(stats.renderRequests, 20);
  assert.equal(stats.cancellations, 19);
  assert.equal(stats.renderCancellations, 38);
  assert.equal(stats.paints, 2);
  assert.equal(stats.activeRenderTasks, 0);
  assert.equal(originalCanvas.draws, 1);
  assert.equal(candidateCanvas.draws, 1);
  assert.equal(events.page.length, 1);
  assert.deepEqual([events.page[0].originalTotalPages, events.page[0].candidateTotalPages], [4, 6]);
  assert.equal(events.text.length, 1);
  assert.equal(events.text[0].original.text, `orig page ${19 % 4 + 1}\nsecond line`);
  assert.equal(events.text[0].candidate.text, `cand page ${(19 * 7) % 6 + 1}\nsecond line`);
  assert.ok(w.log.getPage.every(entry => { const [label, n] = entry.split(':'); return Number(n) >= 1 && Number(n) <= (label === 'orig' ? 4 : 6); }));
  controller.dispose();
});

test('a stale render that ignores cancel and a stale document load never paint', async () => {
  const {w, controller, candidateCanvas} = harness({}, {manualRender: true, ignoreCancel: true});
  await controller.setDocuments({original: null, candidate: await pdfInput('a')});
  const first = controller.show({candidatePageIndex: 1});
  await ticks();
  const second = controller.show({candidatePageIndex: 2});
  await ticks();
  assert.equal(w.pendingRenders.length, 2);
  w.pendingRenders[1].finish();
  assert.equal((await second).status, 'ready');
  w.pendingRenders[0].finish(); // completes after being superseded despite cancel()
  assert.equal((await first).status, 'cancelled');
  await ticks();
  assert.equal(candidateCanvas.content, 'a:2');
  assert.equal(candidateCanvas.draws, 1);

  const loading = harness({}, {manualLoad: true});
  await loading.controller.setDocuments({original: null, candidate: await pdfInput('old')});
  const staleShow = loading.controller.show({candidatePageIndex: 0});
  await ticks();
  await loading.controller.setDocuments({original: null, candidate: await pdfInput('new')});
  const freshShow = loading.controller.show({candidatePageIndex: 0});
  await ticks();
  const [oldLoad, newLoad] = loading.w.pendingLoads;
  newLoad.settle();
  assert.equal((await freshShow).status, 'ready');
  oldLoad.settle();
  assert.equal((await staleShow).status, 'cancelled');
  await ticks();
  assert.equal(loading.candidateCanvas.content, 'new:0');
  assert.deepEqual(loading.w.log.getPage, ['new:1']);
  assert.deepEqual(loading.w.log.renders, ['new:0']);
  controller.dispose();
  loading.controller.dispose();
});

test('a side that finished for a superseded request is not painted beside the other side', async () => {
  const {w, controller, originalCanvas, candidateCanvas} = harness({}, {manualRender: true});
  await controller.setDocuments({original: await pdfInput('o'), candidate: await pdfInput('c')});
  const first = controller.show({originalPageIndex: 1, candidatePageIndex: 1});
  await ticks();
  w.pendingRenders[0].finish(); // original page done; candidate still rendering
  await ticks();
  assert.equal(originalCanvas.draws, 0, 'no half-committed pair');
  const second = controller.show({originalPageIndex: 2, candidatePageIndex: 0});
  await ticks();
  for (const task of w.pendingRenders) task.finish();
  assert.equal((await first).status, 'cancelled');
  assert.equal((await second).status, 'ready');
  assert.deepEqual([originalCanvas.content, candidateCanvas.content], ['o:2', 'c:0']);
  assert.deepEqual([originalCanvas.draws, candidateCanvas.draws], [1, 1]);
  controller.dispose();
});

test('reuses painted pages, held documents and cached documents across candidate swaps', async () => {
  const {w, controller, candidateCanvas} = harness();
  const orig = await pdfInput('orig'), a = await pdfInput('a'), b = await pdfInput('b');
  await controller.setDocuments({original: orig, candidate: a});
  await controller.show({originalPageIndex: 0, candidatePageIndex: 1});
  const again = await controller.show({originalPageIndex: 0, candidatePageIndex: 1});
  assert.equal(again.original.reused, true);
  assert.equal(again.candidate.reused, true);
  assert.equal(again.candidate.text, 'a page 2\nsecond line');
  assert.equal(w.log.renders.length, 2);
  assert.equal(w.log.textCalls, 2);
  await controller.setDocuments({original: orig, candidate: b});
  assert.equal(candidateCanvas.width, 0, 'hash change clears the old candidate buffer');
  await controller.show({originalPageIndex: 0, candidatePageIndex: 0});
  await controller.setDocuments({original: orig, candidate: a});
  await controller.show({originalPageIndex: 0, candidatePageIndex: 1});
  const stats = controller.getStats();
  assert.deepEqual(w.log.loads, ['orig', 'a', 'b']);
  assert.equal(stats.documentLoads, 3);
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.textCacheHits >= 2, true);
  assert.equal(candidateCanvas.content, 'a:1');
  assert.equal(stats.loadedDocuments <= 3, true);
  controller.dispose();
});

test('bounded cache keeps at most three PDFs and disposal releases documents and buffers', async () => {
  const {w, controller, originalCanvas, candidateCanvas, events} = harness();
  await controller.setDocuments({original: await pdfInput('orig'), candidate: await pdfInput('c1')});
  await controller.show();
  for (const label of ['c2', 'c3', 'c4']) {
    await controller.setDocuments({original: await pdfInput('orig'), candidate: await pdfInput(label)});
    await controller.show();
    await ticks();
    assert.equal(controller.getStats().loadedDocuments <= 3, true);
  }
  assert.deepEqual(w.log.destroyed, ['task:c1', 'task:c2']);
  assert.equal(controller.getStats().documentReleases, 3);
  controller.dispose();
  await ticks();
  assert.deepEqual(w.log.destroyed.sort(), ['task:c1', 'task:c2', 'task:c3', 'task:c4', 'task:orig']);
  assert.deepEqual([originalCanvas.width, candidateCanvas.width], [0, 0]);
  assert.equal(events.status.at(-1).state, 'disposed');
  assert.deepEqual(await controller.show(), {status: 'disposed'});
  await assert.rejects(controller.setDocuments({original: null, candidate: null}), /disposed/);
  assert.equal(controller.getStats().disposed, true);
});

test('injected cacheFactory and global FalsifyPaperGeneration cache are reused', async () => {
  const calls = [];
  const factory = options => { calls.push(options); return createBoundedDocumentCache(options); };
  const injected = harness({cacheFactory: factory});
  await injected.controller.setDocuments({original: null, candidate: await pdfInput('x')});
  await injected.controller.show();
  assert.deepEqual(calls, [{maxEntries: 3}]);
  injected.controller.dispose();

  const generation = require('../dist/paper-generation.js');
  const previous = globalThis.FalsifyPaperGeneration;
  let created = 0;
  globalThis.FalsifyPaperGeneration = {createDocumentCache(options) { created++; assert.deepEqual(options, {maxEntries: 3}); return generation.createDocumentCache(options); }};
  try {
    const w = world();
    const controller = createLayoutPreviewController({doc: fakeDoc(), candidateCanvas: fakeCanvas('c'), loadPdf: w.loadPdf});
    const same = await pdfInput('same');
    await controller.setDocuments({original: same, candidate: same});
    const shown = await controller.show({originalPageIndex: 0, candidatePageIndex: 2});
    assert.equal(created, 1);
    assert.deepEqual(w.log.loads, ['same']);
    assert.equal(controller.getStats().cacheHits, 1);
    assert.equal(shown.original.state, 'ready');
    assert.equal(shown.original.text, 'same page 1\nsecond line');
    controller.dispose();
    await ticks();
    assert.deepEqual(w.log.destroyed, ['task:same']);
  } finally {
    if (previous === undefined) delete globalThis.FalsifyPaperGeneration; else globalThis.FalsifyPaperGeneration = previous;
  }
});

test('absent original and unequal page counts never request out-of-range pages', async () => {
  const {w, controller, originalCanvas, events} = harness({}, {pages: {short: 2, long: 5}});
  await controller.setDocuments({original: null, candidate: await pdfInput('long')});
  const absent = await controller.show({originalPageIndex: 3, candidatePageIndex: 4});
  assert.equal(absent.status, 'ready');
  assert.equal(absent.original.state, 'absent');
  assert.equal(absent.candidate.state, 'ready');
  assert.equal(events.text.at(-1).original, null);
  await controller.setDocuments({original: await pdfInput('short'), candidate: await pdfInput('long')});
  const partial = await controller.show({originalPageIndex: 4, candidatePageIndex: 4});
  assert.equal(partial.status, 'partial');
  assert.equal(partial.original.state, 'out-of-range');
  assert.equal(partial.original.totalPages, 2);
  assert.equal(partial.candidate.state, 'ready');
  assert.equal(originalCanvas.width, 0);
  const tooFar = await controller.show({originalPageIndex: 9, candidatePageIndex: 9});
  assert.deepEqual([tooFar.original.state, tooFar.candidate.state], ['out-of-range', 'out-of-range']);
  assert.ok(!w.log.getPage.some(e => e === 'short:5' || e === 'long:10' || e === 'short:10'));
  assert.equal(controller.getStats().outOfRange, 3);
  assert.deepEqual(events.page.at(-1), {requestId: events.page.at(-1).requestId, status: 'partial', originalPageIndex: 9, candidatePageIndex: 9, originalTotalPages: 2, candidateTotalPages: 5,
    original: {pageIndex: 9, totalPages: 2, pdfHash: events.page.at(-1).original.pdfHash, state: 'out-of-range'},
    candidate: {pageIndex: 9, totalPages: 5, pdfHash: events.page.at(-1).candidate.pdfHash, state: 'out-of-range'}});
  controller.dispose();
});

test('cancel() stops an in-flight render without painting and leaves documents reusable', async () => {
  const {w, controller, candidateCanvas, events} = harness({}, {manualRender: true});
  await controller.setDocuments({original: null, candidate: await pdfInput('a')});
  const pending = controller.show({candidatePageIndex: 1});
  await ticks();
  controller.cancel();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(candidateCanvas.draws, 0);
  assert.equal(w.log.cancelled, 1);
  assert.equal(events.status.at(-1).state, 'cancelled');
  const next = controller.show({candidatePageIndex: 1});
  await ticks();
  w.pendingRenders.at(-1).finish();
  assert.equal((await next).status, 'ready');
  const stats = controller.getStats();
  assert.equal(stats.documentLoads, 1);
  assert.equal(stats.cancellations, 1);
  assert.equal(stats.renderCancellations, 1);
  controller.dispose();
});

test('validates hashes, bytes and page indices; load failures are retryable and observers cannot break it', async () => {
  const failing = new Set(['bad']);
  const w = world({failLoad: failing});
  const controller = createLayoutPreviewController({doc: fakeDoc(), candidateCanvas: fakeCanvas('c'), loadPdf: w.loadPdf,
    cacheFactory: createBoundedDocumentCache, onStatus() { throw new Error('observer'); }, onPage() { throw new Error('observer'); }, onText() { throw new Error('observer'); }});
  const good = await pdfInput('good');
  await assert.rejects(controller.setDocuments({candidate: {pdfBytes: good.pdfBytes, pdfHash: (await pdfInput('other')).pdfHash}}), e => e.code === 'pdf-hash-mismatch');
  await assert.rejects(controller.setDocuments({candidate: {pdfBytes: [1, 2], pdfHash: good.pdfHash}}), TypeError);
  await assert.rejects(controller.setDocuments({candidate: {pdfBytes: good.pdfBytes, pdfHash: 'abc'}}), TypeError);
  await assert.rejects(controller.show({candidatePageIndex: -1}), RangeError);
  await assert.rejects(controller.show({originalPageIndex: 1.5}), RangeError);
  await controller.setDocuments({original: null, candidate: await pdfInput('bad')});
  const failed = await controller.show();
  assert.equal(failed.status, 'error');
  assert.equal(failed.candidate.state, 'error');
  assert.match(failed.candidate.error, /cannot open bad/);
  failing.clear();
  const retried = await controller.show();
  assert.equal(retried.status, 'ready');
  assert.deepEqual(w.log.loads, ['bad', 'bad']);
  assert.equal(controller.getStats().loadFailures, 1);
  controller.dispose();
});

test('status callbacks report loading, rendering and ready with request ids', async () => {
  const {controller, events} = harness();
  await controller.setDocuments({original: await pdfInput('o'), candidate: await pdfInput('c')});
  const first = await controller.show();
  await controller.show({candidatePageIndex: 1});
  const states = events.status.map(s => s.state);
  assert.deepEqual(states, ['idle', 'loading', 'ready', 'rendering', 'ready']);
  assert.ok(events.status.every(s => typeof s.message === 'string' && s.message.length));
  assert.equal(events.status[2].requestId, first.requestId);
  controller.dispose();
});

// Minimal synthetic PDF: one Letter-sized page with a black box and text.
function syntheticPdf() {
  const stream = 'q 0 0 0 rg 100 600 200 100 re f Q BT /F1 24 Tf 72 500 Td (Hello preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

test('actual PDF.js renders, crops and extracts text from a synthetic PDF', async t => {
  let napi, pdfjs;
  try {
    napi = await import('@napi-rs/canvas');
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    t.skip(`PDF.js or @napi-rs/canvas unavailable: ${error.message}`);
    return;
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
  const standardFontDataUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');
  const doc = {createElement: () => napi.createCanvas(1, 1)};
  const candidateCanvas = napi.createCanvas(1, 1);
  const texts = [];
  const controller = createLayoutPreviewController({
    doc, candidateCanvas, scale: 1,
    loadPdf: bytes => pdfjs.getDocument({data: bytes, standardFontDataUrl, isEvalSupported: false}),
    onText: x => texts.push(x),
  });
  const pdfBytes = syntheticPdf();
  await controller.setDocuments({original: null, candidate: {pdfBytes, pdfHash: await sha(pdfBytes)}});
  const shown = await controller.show({candidatePageIndex: 0});
  assert.equal(shown.status, 'ready', JSON.stringify(shown));
  assert.deepEqual([candidateCanvas.width, candidateCanvas.height], [612, 792]);
  assert.match(texts[0].candidate.text, /Hello preview/);
  const ctx = candidateCanvas.getContext('2d');
  // PDF box x 100..300, y 600..700 (bottom-up) -> canvas rows 92..192.
  const inside = ctx.getImageData(200, 142, 1, 1).data;
  const outside = ctx.getImageData(400, 142, 1, 1).data;
  assert.ok(inside[0] < 40 && inside[3] > 200, `box pixel ${inside}`);
  assert.ok(outside[3] < 20 || outside[0] > 220, `outside pixel ${outside}`);
  const out = await controller.show({candidatePageIndex: 1});
  assert.equal(out.candidate.state, 'out-of-range');
  controller.dispose();
  assert.notEqual(candidateCanvas.width, 612, 'disposal resets the rendered buffer');
});

test('actual PDF.js: focus outline lands at scaled pixels and clearing restores the page', async t => {
  let napi, pdfjs;
  try {
    napi = await import('@napi-rs/canvas');
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    t.skip(`PDF.js or @napi-rs/canvas unavailable: ${error.message}`);
    return;
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
  const standardFontDataUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');
  const candidateCanvas = napi.createCanvas(1, 1);
  const controller = createLayoutPreviewController({
    doc: {createElement: () => napi.createCanvas(1, 1)}, candidateCanvas, scale: 1.5,
    loadPdf: bytes => pdfjs.getDocument({data: bytes, standardFontDataUrl, isEvalSupported: false}),
  });
  const pdfBytes = syntheticPdf();
  const before = pdfBytes.slice();
  await controller.setDocuments({original: null, candidate: {pdfBytes, pdfHash: await sha(pdfBytes)}});
  // Black box: PDF x 100..300, y 600..700 bottom-up -> top-left display points y 92..192.
  const focus = {document: 'candidate', bbox: [100, 92, 300, 192]};
  const shown = await controller.show({candidatePageIndex: 0, focus});
  assert.equal(shown.focus.state, 'drawn', JSON.stringify(shown.focus));
  assert.deepEqual(shown.focus.pixelRect, [150, 138, 450, 288]);
  const ctx = candidateCanvas.getContext('2d');
  const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  const isRed = p => p[0] > 180 && p[1] < 90 && p[2] < 90;
  const isWhite = p => p[0] > 220 && p[1] > 220 && p[2] > 220;
  const isBlack = p => p[0] < 40 && p[3] > 200;
  const lw = shown.focus.lineWidth; // 2 at scale 1.5; outline centred lw outside the box
  assert.equal(lw, 2);
  assert.ok(isRed(px(150 - lw, 213)), `left edge ${px(150 - lw, 213)}`);
  assert.ok(isRed(px(450 + lw, 213)), `right edge ${px(450 + lw, 213)}`);
  assert.ok(isRed(px(300, 138 - lw)), `top edge ${px(300, 138 - lw)}`);
  assert.ok(isRed(px(300, 288 + lw)), `bottom edge ${px(300, 288 + lw)}`);
  assert.ok(isWhite(px(300, 120)), 'outline does not spill far above the box');
  assert.ok(isBlack(px(300, 213)), 'box interior not covered');
  // Clearing focus on the same cached page restores the clean pixels without re-rendering.
  const cleared = await controller.show({candidatePageIndex: 0});
  assert.equal(cleared.candidate.reused, true);
  assert.ok(isWhite(px(150 - lw, 213)), `outline removed ${px(150 - lw, 213)}`);
  assert.ok(isBlack(px(300, 213)));
  assert.equal(controller.getStats().pageRenders, 1);
  assert.deepEqual(pdfBytes, before, 'PDF bytes never modified');
  controller.dispose();
});

// Canvas fake whose pixels are {content, strokes}: resetting width clears them,
// drawImage copies them, so a stale outline survives only if never restored.
function pixelCanvas(name) {
  let width = 0, height = 0;
  const canvas = {name, dataset: {}, content: null, strokes: [], draws: 0,
    get width() { return width; }, set width(v) { width = v; canvas.content = null; canvas.strokes = []; },
    get height() { return height; }, set height(v) { height = v; canvas.content = null; canvas.strokes = []; },
    getContext() {
      return {canvas, strokeStyle: '', lineWidth: 1, save() {}, restore() {},
        drawImage(src) { canvas.content = src.content; canvas.strokes = (src.strokes || []).map(s => ({...s})); canvas.draws++; },
        strokeRect(x, y, w, h) { canvas.strokes.push({style: this.strokeStyle, lineWidth: this.lineWidth, rect: [x, y, w, h]}); }};
    }};
  return canvas;
}

function focusHarness(worldOptions = {}, scale = 2) {
  const w = world(worldOptions);
  const created = [];
  const doc = {createElement() { const c = pixelCanvas('scratch'); created.push(c); return c; }};
  const originalCanvas = pixelCanvas('original'), candidateCanvas = pixelCanvas('candidate');
  const pages = [];
  const controller = createLayoutPreviewController({doc, originalCanvas, candidateCanvas, loadPdf: w.loadPdf, scale,
    cacheFactory: o => createBoundedDocumentCache(o), onPage: p => pages.push(p)});
  return {w, controller, originalCanvas, candidateCanvas, pages, created};
}
const outlines = canvas => canvas.strokes.filter(s => s.style === '#d93025').map(s => s.rect);

test('focus bbox in top-left display points is scaled to canvas pixels and outlined on the preview only', async () => {
  const {w, controller, originalCanvas, candidateCanvas, pages} = focusHarness({}, 2);
  const orig = await pdfInput('o'), cand = await pdfInput('c');
  const candBytes = cand.pdfBytes.slice();
  await controller.setDocuments({original: orig, candidate: cand});
  // Fake page is 100x140 display points -> 200x280 canvas pixels at scale 2.
  const shown = await controller.show({originalPageIndex: 0, candidatePageIndex: 1, focus: {document: 'candidate', bbox: [10, 20, 50, 60]}});
  assert.equal(shown.status, 'ready');
  assert.deepEqual([candidateCanvas.width, candidateCanvas.height], [200, 280]);
  assert.equal(shown.focus.state, 'drawn');
  assert.equal(shown.focus.document, 'candidate');
  assert.equal(shown.focus.pageIndex, 1);
  assert.deepEqual(shown.focus.bbox, [10, 20, 50, 60]);
  assert.deepEqual(shown.focus.pixelRect, [20, 40, 100, 120]);
  const lw = shown.focus.lineWidth;
  assert.equal(lw, 3);
  // Outline sits just outside the scaled box by one line width.
  assert.deepEqual(outlines(candidateCanvas), [[20 - lw, 40 - lw, 80 + 2 * lw, 80 + 2 * lw]]);
  assert.equal(candidateCanvas.strokes.length, 2, 'white halo + colored outline');
  assert.equal(candidateCanvas.content, 'c:1');
  assert.equal(candidateCanvas.dataset.focusBbox, '10,20,50,60');
  assert.deepEqual(originalCanvas.strokes, [], 'other side has no marker');
  assert.equal('focus' in shown.candidate, false, 'per-side metadata shape unchanged');
  assert.deepEqual(pages.at(-1).focus, shown.focus);
  assert.deepEqual(cand.pdfBytes, candBytes, 'PDF bytes untouched');
  assert.deepEqual(w.log.renders, ['o:0', 'c:1']);

  // Partially off-page bbox is clipped to display bounds; outline stays on canvas.
  const clipped = await controller.show({originalPageIndex: 0, candidatePageIndex: 1, focus: {document: 'candidate', bbox: [-30, 100, 500, 900]}});
  assert.deepEqual(clipped.focus.bbox, [0, 100, 100, 140]);
  assert.deepEqual(clipped.focus.requestedBbox, [-30, 100, 500, 900]);
  const [[x, y, wd, ht]] = outlines(candidateCanvas);
  const half = lw / 2 + 1;
  assert.deepEqual([x, y, x + wd, y + ht], [half, 200 - lw, 200 - half, 280 - half]);
  assert.deepEqual(w.log.renders, ['o:0', 'c:1'], 'focus change re-used the rendered page');
  controller.dispose();
});

test('replacing or clearing focus on the same cached page removes the prior outline', async () => {
  const {w, controller, originalCanvas, candidateCanvas, created} = focusHarness({}, 1);
  await controller.setDocuments({original: await pdfInput('o'), candidate: await pdfInput('c')});
  const page = {originalPageIndex: 0, candidatePageIndex: 0};
  await controller.show({...page, focus: {document: 'candidate', bbox: [10, 10, 20, 20]}});
  assert.equal(outlines(candidateCanvas).length, 1);
  const replaced = await controller.show({...page, focus: {document: 'candidate', bbox: [40, 40, 60, 70]}});
  assert.equal(replaced.candidate.reused, true);
  assert.deepEqual(outlines(candidateCanvas), [[38, 38, 24, 34]], 'only the new outline');
  assert.equal(candidateCanvas.content, 'c:0', 'clean page restored under the new outline');
  // Move focus to the other document: candidate marker cleared, original marked.
  const moved = await controller.show({...page, focus: {document: 'original', bbox: [5, 5, 15, 15]}});
  assert.equal(moved.focus.document, 'original');
  assert.deepEqual(outlines(candidateCanvas), []);
  assert.equal(candidateCanvas.dataset.focusBbox, undefined);
  assert.equal(outlines(originalCanvas).length, 1);
  // Clear focus entirely (no focus key -> metadata unchanged shape).
  const cleared = await controller.show(page);
  assert.equal('focus' in cleared, false);
  assert.deepEqual([originalCanvas.strokes, candidateCanvas.strokes], [[], []]);
  assert.deepEqual([originalCanvas.content, candidateCanvas.content], ['o:0', 'c:0']);
  assert.deepEqual(w.log.renders, ['o:0', 'c:0'], 'no re-render for marker changes');
  assert.ok(created.every(c => c.width === 0), 'no clean-page buffer retained without a marker');
  // A marked page navigated away and back is not resurrected with its marker.
  await controller.show({...page, focus: {document: 'candidate', bbox: [10, 10, 20, 20]}});
  await controller.show({originalPageIndex: 0, candidatePageIndex: 1});
  await controller.show(page);
  assert.deepEqual(candidateCanvas.strokes, []);
  controller.dispose();
});

test('a superseded or cancelled focused request never paints its marker', async () => {
  const {w, controller, candidateCanvas} = focusHarness({manualRender: true}, 1);
  await controller.setDocuments({original: null, candidate: await pdfInput('c')});
  const first = controller.show({candidatePageIndex: 1, focus: {document: 'candidate', bbox: [10, 10, 30, 30]}});
  await ticks();
  const second = controller.show({candidatePageIndex: 2, focus: {document: 'candidate', bbox: [50, 50, 70, 70]}});
  await ticks();
  for (const task of w.pendingRenders) task.finish();
  assert.equal((await first).status, 'cancelled');
  const shown = await second;
  assert.equal(shown.focus.state, 'drawn');
  assert.deepEqual(outlines(candidateCanvas), [[48, 48, 24, 24]]);
  assert.equal(candidateCanvas.content, 'c:2');

  // Focused request superseded by a no-focus request: no stale marker.
  const third = controller.show({candidatePageIndex: 0, focus: {document: 'candidate', bbox: [1, 1, 9, 9]}});
  await ticks();
  const fourth = controller.show({candidatePageIndex: 2});
  await ticks();
  for (const task of w.pendingRenders) task.finish();
  assert.equal((await third).status, 'cancelled');
  assert.equal((await fourth).status, 'ready');
  assert.deepEqual(candidateCanvas.strokes, []);
  assert.equal(candidateCanvas.content, 'c:2');

  // cancel() before the focused render settles leaves the canvas as it was.
  const pending = controller.show({candidatePageIndex: 1, focus: {document: 'candidate', bbox: [1, 1, 9, 9]}});
  await ticks();
  controller.cancel();
  for (const task of w.pendingRenders) task.finish();
  assert.equal((await pending).status, 'cancelled');
  await ticks();
  assert.deepEqual(candidateCanvas.strokes, []);
  assert.equal(candidateCanvas.content, 'c:2');
  controller.dispose();
});

test('invalid or unavailable focus draws no marker and keeps the out-of-range contract', async () => {
  const {controller, originalCanvas, candidateCanvas, pages} = focusHarness({pages: {o: 2, c: 3}}, 1);
  await controller.setDocuments({original: await pdfInput('o'), candidate: await pdfInput('c')});
  for (const focus of [{document: 'other', bbox: [0, 0, 1, 1]}, {document: 'candidate', bbox: [5, 5, 5, 9]},
    {document: 'candidate', bbox: [0, 0, 1]}, {document: 'candidate', bbox: [0, NaN, 1, 1]}, 'nope', {document: 'candidate'}]) {
    const shown = await controller.show({focus});
    assert.equal(shown.status, 'ready');
    assert.equal(shown.focus.state, 'invalid', JSON.stringify(focus));
    assert.deepEqual([originalCanvas.strokes, candidateCanvas.strokes], [[], []]);
  }
  const outside = await controller.show({focus: {document: 'candidate', bbox: [200, 10, 300, 20]}});
  assert.equal(outside.focus.state, 'outside');
  assert.deepEqual(candidateCanvas.strokes, []);
  await controller.show({focus: {document: 'original', bbox: [1, 1, 9, 9]}});
  assert.equal(outlines(originalCanvas).length, 1);
  // Out-of-range original page: metadata contract unchanged, focus unavailable, marker gone.
  const far = await controller.show({originalPageIndex: 5, candidatePageIndex: 0, focus: {document: 'original', bbox: [1, 1, 9, 9]}});
  assert.equal(far.status, 'partial');
  assert.equal(far.original.state, 'out-of-range');
  assert.equal(far.originalPageIndex, 5);
  assert.deepEqual([far.focus.state, far.focus.reason], ['unavailable', 'page-out-of-range']);
  assert.equal(originalCanvas.width, 0);
  assert.deepEqual(originalCanvas.strokes, []);
  assert.deepEqual(pages.at(-1).focus, far.focus);
  controller.dispose();
});
