import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const loaderSource = readFileSync(new URL('../dist/browser-pdf.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../dist/browser-pdf-worker.mjs', import.meta.url), 'utf8');
const FAILED_SHA = 'ab'.repeat(32);
const WARNING_SHA = 'cd'.repeat(32);
const failedVerification = {
  status: 'failed',
  layoutVerified: false,
  checks: [{id: 'word', code: 'present-after', ok: false}],
};
const warningVerification = {
  status: 'warning',
  layoutVerified: false,
  checks: [{id: 'word', code: 'font-substituted', severity: 'warning'}],
};

function pdfFile() {
  return {name: 'paper.pdf', type: 'application/pdf', bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])};
}

function failedPayload(id) {
  return {
    id,
    ok: true,
    name: 'paper.edited.pdf',
    type: 'application/pdf',
    sha256: FAILED_SHA,
    verification: failedVerification,
    pageMap: [{coordinateSpace: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt'}],
    warnings: [{code: 'present-after', severity: 'failed'}],
    bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]).buffer,
  };
}

function withTimeout(promise, ms = 800) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('prepare hung')), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function controllableSignal() {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, fn) { if (type === 'abort') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'abort') listeners.delete(fn); },
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
  return {signal, listeners};
}

function createHarness() {
  const workers = [];
  const control = {workers, constructed: 0, throwOnConstruct: false, failStartup: false, throwOnPost: false, hold: false};
  control.Worker = class StubWorker {
    constructor(url, options) {
      control.constructed += 1;
      if (control.throwOnConstruct) throw new Error('Worker unavailable');
      const startupError = control.failStartup;
      this.url = String(url);
      this.options = options;
      this.terminated = false;
      this.messages = [];
      this.onmessage = null;
      this.onerror = null;
      workers.push(this);
      queueMicrotask(() => {
        if (this.terminated) return;
        if (startupError) { this.onerror?.(); return; }
        this.onmessage?.({data: {ready: true}});
      });
    }

    postMessage(data, transfer) {
      if (control.throwOnPost) throw new Error('postMessage failed');
      this.messages.push({data, transfer});
      if (control.hold) return;
      const payload = failedPayload(data.id);
      queueMicrotask(() => { if (!this.terminated) this.onmessage?.({data: payload}); });
    }

    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      this.onerror?.();
    }

    deliver(data) { this.onmessage?.({data}); }
  };
  return control;
}

function install(Worker) {
  const previous = {document: globalThis.document, Worker: globalThis.Worker, fetch: globalThis.fetch};
  const state = {fetches: 0};
  globalThis.document = {currentScript: {src: 'http://127.0.0.1:9/dist/browser-pdf.js'}};
  globalThis.Worker = Worker;
  globalThis.fetch = (url) => {
    state.fetches += 1;
    throw new Error(`unexpected fetch ${url}`);
  };
  vm.runInThisContext(loaderSource, {filename: 'dist/browser-pdf.js'});
  return {
    api: globalThis.FalsifyBrowserPdf,
    state,
    restore() {
      globalThis.document = previous.document;
      globalThis.Worker = previous.Worker;
      globalThis.fetch = previous.fetch;
    },
  };
}

test('evaluating the classic loader does not construct a worker or fetch wasm', () => {
  assert.equal(loaderSource.includes('mupdf-wasm'), false);
  assert.equal(/import\s*\(|from\s+['"]\.\/browser-pdf\.mjs['"]/.test(loaderSource), false);
  assert.match(workerSource, /new URL\('\.\/browser-pdf\.mjs', import\.meta\.url\)/);
  assert.match(workerSource, /postMessage\(\{ready: true\}\)/);
  const loadedModules = process.moduleLoadList || [];
  assert.equal(loadedModules.some(item => /mupdf|browser-pdf\.mjs|mupdf-wasm/.test(item)), false);
  let constructed = 0;
  const loaded = install(class { constructor() { constructed += 1; } });
  try {
    assert.equal(typeof loaded.api.prepare, 'function');
    assert.equal(constructed, 0);
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});

test('worker constructor failure rejects engine without hanging', async () => {
  const harness = createHarness();
  harness.throwOnConstruct = true;
  const loaded = install(harness.Worker);
  try {
    await assert.rejects(withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}})), error => {
      assert.equal(error.name, 'BrowserPdfError');
      assert.equal(error.code, 'engine');
      assert.match(error.message, /Worker unavailable/);
      return true;
    });
    assert.equal(harness.constructed, 1);
    assert.equal(harness.workers.length, 0);
    assert.equal(loaded.state.fetches, 0);
    harness.throwOnConstruct = false;
    const result = await withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}}));
    assert.equal(result.sha256, FAILED_SHA);
    assert.deepEqual(result.verification, failedVerification);
    assert.equal(result.verification.status, 'failed');
    assert.equal(result.verification.layoutVerified, false);
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, false);
    assert.match(harness.workers[0].url, /browser-pdf-worker\.mjs$/);
    assert.equal(harness.workers[0].url.includes('wasm'), false);
    assert.equal(harness.workers[0].options.type, 'module');
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});

test('aborting a completed request does not terminate the next job', async () => {
  const harness = createHarness();
  const loaded = install(harness.Worker);
  const firstSignal = controllableSignal();
  const original = pdfFile();
  try {
    const first = await withTimeout(loaded.api.prepare({file: original, edits: {schema: 'falsify.paper-edits.v1', edits: []}, signal: firstSignal.signal}));
    assert.equal(first.sha256, FAILED_SHA);
    assert.equal(first.verification.status, 'failed');
    assert.equal(first.verification.layoutVerified, false);
    assert.deepEqual(first.warnings, [{code: 'present-after', severity: 'failed'}]);
    assert.equal(firstSignal.listeners.size, 0);
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, false);
    assert.deepEqual([...original.bytes], [0x25, 0x50, 0x44, 0x46, 0x2d]);
    harness.hold = true;
    let settled = false;
    const second = loaded.api.prepare({file: pdfFile(), edits: {}}).then(value => { settled = true; return value; });
    await flush();
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].messages.length, 2);
    assert.equal(settled, false);
    firstSignal.signal.abort();
    await flush();
    assert.equal(settled, false);
    assert.equal(harness.workers[0].terminated, false);
    assert.equal(harness.workers.length, 1);
    const pending = harness.workers[0].messages[1].data;
    harness.workers[0].deliver({
      id: pending.id,
      ok: true,
      name: 'paper.edited.pdf',
      type: 'application/pdf',
      sha256: WARNING_SHA,
      verification: warningVerification,
      pageMap: [],
      warnings: [{code: 'font-substituted', severity: 'warning'}],
      bytes: new ArrayBuffer(4),
    });
    const result = await withTimeout(second);
    assert.equal(result.sha256, WARNING_SHA);
    assert.deepEqual(result.verification, warningVerification);
    assert.equal(result.verification.status, 'warning');
    assert.equal(result.verification.layoutVerified, false);
    assert.deepEqual(result.warnings, [{code: 'font-substituted', severity: 'warning'}]);
    assert.equal(harness.workers[0].terminated, false);
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});

test('cancelling an unread file does not terminate another active request', async () => {
  const harness = createHarness();
  harness.hold = true;
  const loaded = install(harness.Worker);
  const signal = controllableSignal();
  let releaseRead;
  try {
    const active = loaded.api.prepare({file: pdfFile(), edits: {}});
    await flush();
    const unread = loaded.api.prepare({file: {name: 'slow.pdf', arrayBuffer: () => new Promise(resolve => { releaseRead = resolve; })}, edits: {}, signal: signal.signal});
    const cancelled = assert.rejects(unread, error => error.code === 'aborted');
    signal.signal.abort();
    await cancelled;
    assert.equal(harness.workers[0].terminated, false);
    const message = harness.workers[0].messages[0].data;
    harness.workers[0].deliver(failedPayload(message.id));
    assert.equal((await withTimeout(active)).sha256, FAILED_SHA);
    releaseRead(new ArrayBuffer(4));
    await flush();
    assert.equal(harness.workers[0].messages.length, 1);
  } finally { loaded.restore(); }
});

test('postMessage failure rejects engine and the next prepare uses a new worker', async () => {
  const harness = createHarness();
  harness.throwOnPost = true;
  const loaded = install(harness.Worker);
  try {
    await assert.rejects(withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}})), error => {
      assert.equal(error.code, 'engine');
      assert.match(error.message, /postMessage failed/);
      return true;
    });
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, true);
    harness.workers[0].deliver({
      id: 1,
      ok: true,
      name: 'stale.pdf',
      type: 'application/pdf',
      sha256: 'ee'.repeat(32),
      verification: {status: 'applied', layoutVerified: true},
      warnings: [],
      bytes: new ArrayBuffer(1),
    });
    harness.throwOnPost = false;
    const result = await withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}}));
    assert.equal(harness.workers.length, 2);
    assert.equal(harness.workers[1].terminated, false);
    assert.notEqual(harness.workers[1], harness.workers[0]);
    assert.equal(result.sha256, FAILED_SHA);
    assert.equal(result.verification.status, 'failed');
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});

test('abort before the job is linked preserves the unrelated idle worker', async () => {
  const harness = createHarness();
  const loaded = install(harness.Worker);
  const signal = controllableSignal();
  try {
    await withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}}));
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, false);
    const cancelled = withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}, signal: signal.signal}));
    signal.signal.abort();
    await assert.rejects(cancelled, error => error.code === 'aborted');
    assert.equal(harness.workers[0].terminated, false);
    assert.equal(harness.workers.length, 1);
    const again = await withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}}));
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, false);
    assert.equal(again.verification.status, 'failed');
    assert.equal(again.sha256, FAILED_SHA);
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});

test('worker startup error settles ready and pending work', async () => {
  const harness = createHarness();
  harness.failStartup = true;
  const loaded = install(harness.Worker);
  try {
    await assert.rejects(withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}})), error => {
      assert.equal(error.code, 'engine');
      assert.match(error.message, /PDF 워커가 실패했습니다/);
      return true;
    });
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.workers[0].terminated, true);
    harness.failStartup = false;
    const result = await withTimeout(loaded.api.prepare({file: pdfFile(), edits: {}}));
    assert.equal(harness.workers.length, 2);
    assert.equal(harness.workers[1].terminated, false);
    assert.equal(result.sha256, FAILED_SHA);
    assert.equal(result.verification.status, 'failed');
    assert.equal(result.verification.layoutVerified, false);
    assert.equal(loaded.state.fetches, 0);
  } finally { loaded.restore(); }
});
