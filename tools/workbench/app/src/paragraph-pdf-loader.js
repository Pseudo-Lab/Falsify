/* AGPL-3.0-only. Loading this file does not load the engine or WASM. */
(function(root) {
  'use strict';
  var current = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var nextId = 1;
  function failure(code, message) { return Object.assign(new Error(message), {name: 'ParagraphPdfError', code: code}); }
  function run(operation, request) {
    request = request || {};
    var signal = request.signal, worker, settled = false, id = nextId++;
    var fontSnapshot = request.fontSnapshot ? structuredClone(request.fontSnapshot) : undefined;
    return new Promise(function(resolve, reject) {
      function finish(error, result) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancel);
        if (worker) worker.terminate();
        if (error) reject(error); else resolve(result);
      }
      function cancel() { finish(failure('aborted', 'PDF editing cancelled.')); }
      if (signal && signal.aborted) { cancel(); return; }
      if (signal) signal.addEventListener('abort', cancel, {once: true});
      Promise.resolve().then(async function() {
        if (!current) throw failure('engine', 'Paragraph loader requires a script URL.');
        var file = request.file;
        if (file && Number.isFinite(file.size) && file.size > 25 * 1024 * 1024) throw failure('limit', 'PDF exceeds the 25 MiB size limit.');
        var bytes = file instanceof Uint8Array ? new Uint8Array(file)
          : file && file.bytes instanceof Uint8Array ? new Uint8Array(file.bytes)
          : file && typeof file.arrayBuffer === 'function' ? new Uint8Array(await file.arrayBuffer()) : null;
        if (settled) return;
        if (!bytes || !bytes.length || bytes.length > 25 * 1024 * 1024) throw failure('invalid', 'A PDF within the 25 MiB size limit is required.');
        var url = new URL('./paragraph-pdf-worker.mjs', current);
        url.search = new URL(current).search;
        // A request owns its worker. Aborting one PDF cannot cancel another.
        worker = new Worker(url, {type: 'module'});
        worker.onerror = function() { finish(failure('engine', 'Paragraph PDF worker failed.')); };
        worker.onmessage = function(event) {
          var data = event.data || {};
          if (settled || data.id !== id) return;
          if (!data.ok) { finish(Object.assign(failure(data.error.code, data.error.message), {details: data.error.details, report: data.error.report})); return; }
          if (operation === 'prepare') data.result.file = new File([data.bytes], data.name, {type: 'application/pdf'});
          finish(null, data.result);
        };
        worker.postMessage({id: id, operation: operation, name: file.name || 'document.pdf', bytes: bytes.buffer,
          edits: request.edits, pageIndex: request.pageIndex, fileHash: request.fileHash || '', fontSnapshot: fontSnapshot}, [bytes.buffer]);
      }).catch(function(error) { finish(error); });
    });
  }
  root.FalsifyParagraphPdf = {
    COORDINATE_SPACE: 'top-left-page',
    COORDINATES: {space: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt'},
    inspectPage: function(request) { return run('inspectPage', request); },
    prepare: function(request) { return run('prepare', request); },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
