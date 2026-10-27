/* Copy the pinned MuPDF.js browser build and bundle FalsifyBrowserPdf.
 * Does not compile MuPDF or download private editor artifacts.
 */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorSrc = join(app, 'node_modules/mupdf/dist');
const vendor = join(app, 'dist/browser-pdf-vendor');
const files = ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm'];
mkdirSync(vendor, {recursive: true});
writeFileSync(join(vendor, 'package.json'), JSON.stringify({name: 'falsify-browser-pdf-vendor', private: true, type: 'module'}) + '\n');

const digests = {};
for (const name of files) {
  const bytes = readFileSync(join(vendorSrc, name));
  writeFileSync(join(vendor, name), bytes);
  digests[name] = {sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
}
const pkg = JSON.parse(readFileSync(join(app, 'node_modules/mupdf/package.json'), 'utf8'));
if (pkg.version !== '1.28.1' || pkg.license !== 'AGPL-3.0-or-later') {
  throw new Error('refusing to vendor unexpected mupdf package ' + pkg.version + ' ' + pkg.license);
}

const manifest = {
  schema: 'falsify.browser-pdf.vendor.v1',
  engine: 'mupdf.js',
  version: pkg.version,
  license: pkg.license,
  npm: 'https://www.npmjs.com/package/mupdf/v/1.28.1',
  source: 'https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1',
  correspondingSource: 'https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1',
  provenance: 'Official npm browser/Node WASM and glue. Copied byte-for-byte from the installed mupdf@1.28.1 package. Not rebuilt from C sources and not a private falsify-pdf-editor candidate.',
  notUsed: [
    'Shinick-Han/falsify-pdf-editor b2d6ff204fc00a540eed98097895aec3f08b8047 editcore: verified stream-order WASM is an untracked patched build, and the upstream PDFium binary is not a substitute',
    'annotation-only FreeText, white overlay, raster-all-pages',
  ],
  files: digests,
};
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(vendor, 'NOTICE.md'), `# MuPDF.js ${pkg.version}

Copyright (C) 2004-2026 Artifex Software, Inc.

MuPDF is free software under the GNU Affero General Public License,
version 3 or later. The terms are in the workbench \`LICENSE\` file
(AGPL-3.0). Upstream source for this pinned release:

- https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1
- https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1
- npm \`mupdf@1.28.1\` (https://www.npmjs.com/package/mupdf/v/1.28.1)

\`mupdf.js\`, \`mupdf-wasm.js\` and \`mupdf-wasm.wasm\` are the official
package artifacts named in \`manifest.json\`, with SHA-256 recorded there.
This repository does not rebuild those binaries. Alternative commercial
terms, if any, are available from Artifex and are not granted here.

Falsify workbench code that calls this engine is AGPL-3.0-only.
The browser editor removes text with MuPDF redaction and writes new text
operators. It does not ship the falsify-pdf-editor patched PDFium candidate.
`);

await build({
  entryPoints: [join(app, 'src/browser-pdf.mjs')],
  outfile: join(app, 'dist/browser-pdf.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'eof',
  plugins: [{
    name: 'mupdf-vendor',
    setup(build) {
      build.onResolve({filter: /^mupdf$/}, () => ({path: './browser-pdf-vendor/mupdf.js', external: true}));
    },
  }],
});

writeFileSync(join(app, 'dist/browser-pdf-worker.mjs'), `const engineUrl = new URL('./browser-pdf.mjs', import.meta.url);
engineUrl.search = new URL(import.meta.url).search;
const {prepare} = await import(engineUrl.href);

self.onmessage = async (event) => {
  const data = event.data || {};
  const id = data.id;
  try {
    const owned = new Uint8Array(data.bytes);
    const result = await prepare({
      file: {name: data.name || 'document.pdf', bytes: owned, type: data.type || 'application/pdf'},
      edits: data.edits,
      fileHash: data.fileHash || '',
      fontSnapshot: data.fontSnapshot,
    });
    const out = new Uint8Array(await result.file.arrayBuffer());
    const copy = new ArrayBuffer(out.byteLength);
    new Uint8Array(copy).set(out);
    self.postMessage({
      id,
      ok: true,
      name: result.file.name,
      type: result.file.type,
      sha256: result.sha256,
      verification: result.verification,
      pageMap: result.pageMap,
      warnings: result.warnings,
      bytes: copy,
    }, [copy]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error && error.name || 'Error',
        message: String(error && error.message || 'engine'),
        code: error && error.code || 'engine',
        details: error && error.details || {},
      },
    });
  }
};
self.postMessage({ready: true});
`);

writeFileSync(join(app, 'dist/browser-pdf.js'), `/*!
 * FalsifyBrowserPdf classic loader. Evaluating this script does not import
 * MuPDF or the WASM. The first prepare() starts dist/browser-pdf-worker.mjs,
 * which loads browser-pdf.mjs and the AGPL runtime. See browser-pdf-vendor/NOTICE.md.
 */
(function (root) {
  'use strict';
  var current = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var worker = null;
  var jobs = new Map();
  var nextId = 1;
  var coordinates = {space: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt'};

  function abortedError() {
    var error = new Error('편집이 취소되었습니다. PDF는 만들지 않았습니다.');
    error.name = 'BrowserPdfError';
    error.code = 'aborted';
    error.details = {};
    return error;
  }

  function engineError(payload) {
    var error = new Error(payload && payload.message || 'engine');
    error.name = 'BrowserPdfError';
    error.code = payload && payload.code || 'engine';
    error.details = payload && payload.details || {};
    return error;
  }

  function resetWorker(target, error) {
    if (!target || target._reset) return;
    target._reset = true;
    if (worker === target) worker = null;
    var pending = [];
    jobs.forEach(function (job) { if (job.worker === target) pending.push(job); });
    if (typeof target._settleReady === 'function') target._settleReady(error);
    try { target.terminate(); } catch (terminateError) { /* already stopped */ }
    pending.forEach(function (job) { job.finish(error); });
  }

  function spawn(scriptUrl) {
    var workerUrl = new URL('./browser-pdf-worker.mjs', scriptUrl);
    workerUrl.search = new URL(scriptUrl).search;
    var created = new Worker(workerUrl, {type: 'module'});
    var readySettled = false;
    var markReady, rejectReady;
    created.ready = new Promise(function (resolve, reject) {
      markReady = resolve;
      rejectReady = reject;
    });
    created._settleReady = function (error) {
      if (readySettled) return;
      readySettled = true;
      if (error) rejectReady(error);
      else markReady();
    };
    created.onmessage = function (event) {
      var data = event.data || {};
      if (data.ready) { created._settleReady(); return; }
      var job = jobs.get(data.id);
      if (!job || job.worker !== created) return;
      if (!data.ok) { job.finish(engineError(data.error)); return; }
      var bytes = new Uint8Array(data.bytes);
      var file = new File([bytes], data.name, {type: data.type || 'application/pdf'});
      job.finish(null, {file: file, sha256: data.sha256, verification: data.verification, pageMap: data.pageMap, warnings: data.warnings});
    };
    created.onerror = function () {
      resetWorker(created, engineError({code: 'engine', message: 'PDF 워커가 실패했습니다. 출력 파일은 만들지 않았습니다.'}));
    };
    return created;
  }

  function freshBuffer(bytes) {
    var copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  async function readFileBytes(file) {
    if (file instanceof Uint8Array) return new Uint8Array(file);
    if (file && typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    if (file && file.bytes instanceof Uint8Array) return new Uint8Array(file.bytes);
    throw engineError({code: 'invalid', message: 'PDF File 또는 bytes가 필요합니다.'});
  }

  root.FalsifyBrowserPdf = {
    COORDINATE_SPACE: coordinates.space,
    COORDINATES: coordinates,
    prepare: function (request) {
      if (!current) return Promise.reject(new Error('FalsifyBrowserPdf 로더는 script URL이 필요합니다.'));
      var signal = request && request.signal;
      var fontSnapshot = request && request.fontSnapshot ? structuredClone(request.fontSnapshot) : undefined;
      if (signal && signal.aborted) return Promise.reject(abortedError());
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', cancel);
          jobs.delete(id);
          if (error) reject(error);
          else resolve(value);
        }
        function cancel() {
          if (settled) return;
          var job = jobs.get(id);
          var target = job && job.worker;
          finish(abortedError());
          if (target) resetWorker(target, abortedError());
        }
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', cancel);
        readFileBytes(request && request.file).then(function (bytes) {
          try {
            if (settled || (signal && signal.aborted)) { finish(abortedError()); return; }
            if (!worker || worker._reset) worker = spawn(current);
            var target = worker;
            if (target._reset) {
              if (worker === target) worker = null;
              finish(engineError({code: 'engine', message: 'PDF 워커가 실패했습니다. 출력 파일은 만들지 않았습니다.'}));
              return;
            }
            jobs.set(id, {finish: finish, worker: target});
            target.ready.then(function () {
              if (settled) return;
              if (signal && signal.aborted) {
                finish(abortedError());
                resetWorker(target, abortedError());
                return;
              }
              var buffer = freshBuffer(bytes);
              try {
                target.postMessage({
                  id: id,
                  name: request.file && request.file.name || 'document.pdf',
                  type: request.file && request.file.type || 'application/pdf',
                  fileHash: request.fileHash || '',
                  fontSnapshot: fontSnapshot,
                  edits: request.edits,
                  bytes: buffer,
                }, [buffer]);
              } catch (error) {
                var failure = engineError({code: 'engine', message: String(error && error.message || error)});
                finish(failure);
                resetWorker(target, failure);
              }
            }, function (error) {
              finish(error && error.code ? error : engineError({code: 'engine', message: String(error && error.message || error)}));
            });
          } catch (error) {
            finish(engineError({code: 'engine', message: String(error && error.message || error)}));
          }
        }, function (error) {
          finish(error && error.code ? error : engineError({code: 'engine', message: String(error && error.message || error)}));
        });
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
`);
console.log('browser-pdf vendored', pkg.version, digests['mupdf-wasm.wasm'].sha256);
