/*
 * Original/candidate PDF preview controller for the paper-layout result card.
 *
 * Renders independently selected pages of the captured original PDF and the
 * current layout candidate. Documents are keyed by verified SHA-256 hash and
 * kept in a bounded cache (at most three loaded PDFs). Every show() supersedes
 * the previous request: its PDF.js render tasks are cancelled and its pages are
 * never painted. Pages are rendered to a scratch canvas and copied onto the
 * visible canvas only while the request is still current.
 *
 * show() optionally takes focus {document, bbox:[x0,y0,x1,y1]} in top-left
 * display points (PDF.js viewport at scale 1 / MuPDF page bounds). The bbox is
 * clipped to the shown page and outlined on the visible preview canvas only;
 * PDF bytes are never modified. While a marker is drawn, one clean copy of that
 * side's page is retained so a replaced or cleared focus restores the unmarked
 * page without re-rendering. Superseded requests never draw or clear markers.
 *
 * No model or backend calls are made; the only network access is the default
 * loader's lazy import of the bundled PDF.js vendor files.
 */
import {hex as syncSha256Hex} from './paragraph-pdf-crypto.mjs';

const MAX_LOADED_DOCUMENTS = 3;
const MAX_TEXT_ENTRIES = 12;
const DEFAULT_SCALE = 1.2;
const SIDES = ['original', 'candidate'];
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FOCUS_COLOR = '#d93025';
const FOCUS_HALO = '#ffffff';

const MESSAGES = {
  idle: '미리보기 대기 중',
  loading: 'PDF를 여는 중',
  rendering: '페이지를 그리는 중',
  ready: '미리보기 준비됨',
  partial: '일부 페이지를 표시하지 못했습니다',
  cancelled: '미리보기 요청을 취소했습니다',
  error: '미리보기를 표시하지 못했습니다',
  disposed: '미리보기를 닫았습니다',
};

function toHex(bytes) {
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  return syncSha256Hex(bytes);
}

function cancelledError() {
  const error = new Error('Preview request superseded');
  error.name = 'AbortError';
  return error;
}

function isCancellation(error) {
  return error?.name === 'AbortError' || error?.name === 'RenderingCancelledException';
}

/*
 * Bounded document cache with the FalsifyPaperGeneration.createDocumentCache
 * interface. Unreferenced entries beyond maxEntries are destroyed, including
 * still-pending loading tasks, so abandoned loads stop work.
 */
export function createBoundedDocumentCache({maxEntries = MAX_LOADED_DOCUMENTS} = {}) {
  const limit = Math.max(1, Math.min(MAX_LOADED_DOCUMENTS, Number(maxEntries) || MAX_LOADED_DOCUMENTS));
  const entries = new Map();
  let disposed = false;
  function destroy(entry) {
    if (entry.destroyed) return;
    entry.destroyed = true;
    if (entry.task && typeof entry.task.destroy === 'function') {
      try { Promise.resolve(entry.task.destroy()).catch(() => {}); } catch { /* destroy is best effort */ }
      return;
    }
    entry.promise.then(d => (d && typeof d.destroy === 'function' ? d.destroy() : undefined)).catch(() => {});
  }
  function trim() {
    for (const [key, entry] of entries) {
      if (entries.size <= limit) break;
      if (!entry.refs) { entries.delete(key); destroy(entry); }
    }
  }
  async function load(key, loader) {
    if (disposed) throw new Error('Document cache disposed');
    let entry = entries.get(key);
    if (!entry) {
      const task = loader();
      entry = {task, refs: 0, destroyed: false, promise: Promise.resolve(task && task.promise ? task.promise : task)};
      entries.set(key, entry);
      const current = entry;
      entry.promise.catch(() => { if (entries.get(key) === current) entries.delete(key); });
    } else {
      entries.delete(key);
      entries.set(key, entry);
    }
    entry.refs++;
    trim();
    try {
      const value = await entry.promise;
      if (disposed || entry.destroyed) throw new Error('Document cache disposed');
      return value;
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1);
      trim();
      throw error;
    }
  }
  function release(key) {
    const entry = entries.get(key);
    if (entry && entry.refs > 0) entry.refs--;
    trim();
  }
  function dispose() {
    disposed = true;
    for (const entry of entries.values()) destroy(entry);
    entries.clear();
  }
  return {load, release, dispose, get size() { return entries.size; }};
}

function validateDocument(value, side) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new TypeError(`${side} must be null or {pdfBytes,pdfHash}`);
  const {pdfBytes, pdfHash} = value;
  if (!(pdfBytes instanceof Uint8Array) || pdfBytes.byteLength === 0) throw new TypeError(`${side}.pdfBytes must be a non-empty Uint8Array`);
  if (typeof pdfHash !== 'string' || !HASH_PATTERN.test(pdfHash)) throw new TypeError(`${side}.pdfHash must be a lowercase SHA-256 hex string`);
  return {pdfBytes, pdfHash};
}

function validatePageIndex(value, name) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function pageText(content) {
  const lines = [];
  let line = '';
  for (const item of content?.items || []) {
    if (typeof item?.str !== 'string') continue;
    line += item.str;
    if (item.hasEOL) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);
  return lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function defaultScratchFactory(doc, canvases) {
  const owner = doc || canvases.find(c => c?.ownerDocument)?.ownerDocument;
  if (owner && typeof owner.createElement === 'function') return () => owner.createElement('canvas');
  if (typeof OffscreenCanvas === 'function') return () => new OffscreenCanvas(1, 1);
  return null;
}

function clearCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  if (canvas.dataset) {
    delete canvas.dataset.pdfHash;
    delete canvas.dataset.pageIndex;
    delete canvas.dataset.scale;
    delete canvas.dataset.focusBbox;
  }
}

// Focus is optional and never throws: a malformed value yields {state:'invalid'}.
function normalizeFocus(focus) {
  if (focus === undefined || focus === null) return null;
  const document = SIDES.includes(focus?.document) ? focus.document : null;
  const bbox = focus?.bbox;
  const valid = document && Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1];
  if (!valid) return {document, state: 'invalid'};
  return {document, bbox: bbox.map(Number)};
}

const round3 = value => Math.round(value * 1000) / 1000;

// Clip a display-point bbox to the page and convert it to canvas pixels.
function focusGeometry(bbox, display, renderScale, canvas) {
  const x0 = Math.max(0, Math.min(bbox[0], display.width));
  const x1 = Math.max(0, Math.min(bbox[2], display.width));
  const y0 = Math.max(0, Math.min(bbox[1], display.height));
  const y1 = Math.max(0, Math.min(bbox[3], display.height));
  if (!(x1 > x0 && y1 > y0)) return {state: 'outside'};
  const clipped = [x0, y0, x1, y1].map(round3);
  const pixelRect = [x0, y0, x1, y1].map(v => v * renderScale);
  const lineWidth = Math.max(2, Math.round(renderScale * 1.5));
  const half = lineWidth / 2 + 1; // halo is lineWidth + 2 wide
  const gap = lineWidth;
  const ox0 = Math.max(half, pixelRect[0] - gap), oy0 = Math.max(half, pixelRect[1] - gap);
  const ox1 = Math.min(canvas.width - half, pixelRect[2] + gap), oy1 = Math.min(canvas.height - half, pixelRect[3] + gap);
  const outline = [ox0, oy0, Math.max(0, ox1 - ox0), Math.max(0, oy1 - oy0)].map(round3);
  return {state: 'drawn', bbox: clipped, pixelRect: pixelRect.map(round3), outline, lineWidth};
}

function strokeFocus(canvas, geometry) {
  const ctx = canvas.getContext('2d');
  const [x, y, w, h] = geometry.outline;
  ctx.save?.();
  ctx.strokeStyle = FOCUS_HALO;
  ctx.lineWidth = geometry.lineWidth + 2;
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = FOCUS_COLOR;
  ctx.lineWidth = geometry.lineWidth;
  ctx.strokeRect(x, y, w, h);
  ctx.restore?.();
}

export function createLayoutPreviewController({
  doc = globalThis.document,
  originalCanvas = null,
  candidateCanvas = null,
  loadPdf,
  baseUrl,
  onStatus,
  onPage,
  onText,
  cacheFactory,
  scale = DEFAULT_SCALE,
} = {}) {
  const canvases = {original: originalCanvas, candidate: candidateCanvas};
  const createScratch = defaultScratchFactory(doc, [originalCanvas, candidateCanvas]);
  const renderScale = Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SCALE;
  const stats = {
    documentLoads: 0, cacheHits: 0, documentReuses: 0, documentReleases: 0, loadFailures: 0,
    renderRequests: 0, pageRenders: 0, renderReuses: 0, paints: 0,
    cancellations: 0, renderCancellations: 0, staleDiscards: 0,
    textExtractions: 0, textCacheHits: 0, outOfRange: 0,
  };
  const cache = cacheFactory
    ? cacheFactory({maxEntries: MAX_LOADED_DOCUMENTS})
    : (globalThis.FalsifyPaperGeneration?.createDocumentCache
      ? globalThis.FalsifyPaperGeneration.createDocumentCache({maxEntries: MAX_LOADED_DOCUMENTS})
      : createBoundedDocumentCache({maxEntries: MAX_LOADED_DOCUMENTS}));
  if (!cache || typeof cache.load !== 'function' || typeof cache.release !== 'function') throw new TypeError('cacheFactory must return {load,release,dispose}');

  const sides = Object.fromEntries(SIDES.map(name => [name, {name, document: null, docPromise: null, painted: '', paintedDisplay: null, marker: '', base: null}]));
  const textCache = new Map();
  const activeTasks = new Set();
  let ticket = 0;
  let inflight = null;
  let documentsEpoch = 0;
  let documentsReady = Promise.resolve();
  let disposed = false;
  let library = null;

  const notify = (fn, value) => { if (typeof fn !== 'function') return; try { fn(value); } catch { /* observer failures cannot alter preview state */ } };
  const status = (state, extra = {}) => notify(onStatus, {state, message: MESSAGES[state] || state, ...extra});

  async function defaultLoader(bytes) {
    if (!library) {
      const root = baseUrl || doc?.baseURI || globalThis.location?.href;
      if (!root) throw new Error('baseUrl is required to load PDF.js');
      const lib = await import(new URL('vendor/pdf.mjs', root).href);
      if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.mjs', root).href;
      library = {lib, root};
    }
    const {lib, root} = library;
    return lib.getDocument({
      data: bytes.slice(),
      cMapUrl: new URL('vendor/cmaps/', root).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('vendor/standard_fonts/', root).href,
      wasmUrl: new URL('vendor/wasm/', root).href,
    });
  }

  function startLoad(bytes) {
    stats.documentLoads++;
    if (typeof loadPdf === 'function') return loadPdf(bytes.slice());
    // The default loader is async (library import); expose a loading-task shape
    // whose destroy() also reaches the real task once it exists.
    let task = null, destroyed = false;
    const promise = defaultLoader(bytes).then(t => {
      task = t;
      if (destroyed) { try { t.destroy?.(); } catch { /* ignore */ } throw cancelledError(); }
      return t.promise ?? t;
    });
    return {promise, destroy() { destroyed = true; return task?.destroy?.(); }};
  }

  function releaseSide(side) {
    const {document, docPromise} = side;
    side.document = null;
    side.docPromise = null;
    wipe(side);
    if (!document || !docPromise) return;
    // Release only a reference that was actually acquired; failed loads already
    // dropped their reference inside the cache.
    docPromise.then(() => { stats.documentReleases++; cache.release(document.pdfHash); }, () => {});
  }

  function cancelTasks() {
    for (const task of activeTasks) {
      try { task.cancel?.(); stats.renderCancellations++; } catch { /* already finished */ }
    }
    activeTasks.clear();
  }

  // Supersede the in-flight request (if any): it is counted as cancelled, its
  // render tasks are cancelled and its results are never painted.
  function supersede() {
    if (inflight !== null) { stats.cancellations++; inflight = null; }
    ticket++;
    cancelTasks();
  }

  function acquire(side) {
    if (side.docPromise) { stats.documentReuses++; return side.docPromise; }
    const {pdfHash, pdfBytes} = side.document;
    let invoked = false;
    const promise = cache.load(pdfHash, () => { invoked = true; return startLoad(pdfBytes); });
    promise.then(() => { if (!invoked) stats.cacheHits++; }, () => {});
    side.docPromise = promise;
    const owner = side.document;
    promise.catch(() => {
      if (side.document === owner && side.docPromise === promise) side.docPromise = null;
    });
    return promise;
  }

  function current(requestTicket) {
    return !disposed && requestTicket === ticket;
  }

  async function extractText(page, key) {
    if (textCache.has(key)) {
      stats.textCacheHits++;
      const text = textCache.get(key);
      textCache.delete(key);
      textCache.set(key, text);
      return text;
    }
    const text = pageText(await page.getTextContent());
    stats.textExtractions++;
    textCache.set(key, text);
    while (textCache.size > MAX_TEXT_ENTRIES) textCache.delete(textCache.keys().next().value);
    return text;
  }

  // Paint helpers run only from commit(), after both sides settled for a
  // request that is still current, so the two canvases never mix requests.
  function blank(side, marker) {
    const canvas = canvases[side.name];
    if (canvas && side.painted !== marker) clearCanvas(canvas);
    if (side.painted !== marker || side.marker) dropMarker(side);
    side.painted = marker;
    side.paintedDisplay = null;
  }

  function freeScratch(scratch) {
    if (!scratch) return;
    scratch.width = 0;
    scratch.height = 0;
  }

  function dropMarker(side) {
    freeScratch(side.base);
    side.base = null;
    side.marker = '';
  }

  // Forget everything painted on a side (document change, release, dispose).
  function wipe(side) {
    if (canvases[side.name]) clearCanvas(canvases[side.name]);
    dropMarker(side);
    side.painted = '';
    side.paintedDisplay = null;
  }

  // Bring the visible canvas of a painted side to exactly one marker (or none).
  // Called only from commit(), i.e. for the current request.
  function applyMarker(side, geometry) {
    const canvas = canvases[side.name];
    if (!canvas) return;
    const signature = geometry?.state === 'drawn' ? geometry.outline.join(',') : '';
    if (signature === side.marker) return;
    if (side.marker) {
      // Restore the clean page: resetting width clears the old outline.
      const {width, height} = canvas;
      canvas.width = width;
      canvas.height = height;
      if (side.base) canvas.getContext('2d').drawImage(side.base, 0, 0);
      if (canvas.dataset) delete canvas.dataset.focusBbox;
    }
    if (!signature) { dropMarker(side); return; }
    if (!side.base) {
      const base = createScratch ? createScratch() : null;
      if (!base) { geometry.state = 'unavailable'; geometry.reason = 'no-canvas-factory'; return; }
      base.width = canvas.width;
      base.height = canvas.height;
      base.getContext('2d').drawImage(canvas, 0, 0);
      side.base = base;
    }
    strokeFocus(canvas, geometry);
    if (canvas.dataset) canvas.dataset.focusBbox = geometry.bbox.join(',');
    side.marker = signature;
  }

  // Focus outcome for one side once its page state is known (pre-commit).
  function sideFocus(side, focus, state, pageIndex, display, size) {
    if (!focus || focus.document !== side.name || focus.state === 'invalid') return null;
    const out = {document: side.name, pageIndex, requestedBbox: focus.bbox.slice()};
    if (state !== 'ready') return {...out, state: 'unavailable', reason: `page-${state}`};
    if (!canvases[side.name]) return {...out, state: 'unavailable', reason: 'no-canvas'};
    if (!display || !size) return {...out, state: 'unavailable', reason: 'no-display-bounds'};
    return {...out, ...focusGeometry(focus.bbox, display, renderScale, size)};
  }

  // Prepare one side for a request without touching the visible canvas.
  // Resolves to {result, commit, discard}; rejects with AbortError when stale.
  async function prepareSide(side, pageIndex, requestTicket, focus) {
    const base = {pageIndex, totalPages: 0, pdfHash: side.document?.pdfHash || null};
    const noop = () => {};
    const unavailable = state => sideFocus(side, focus, state, pageIndex);
    if (!side.document) return {result: {...base, state: 'absent', text: '', focus: unavailable('absent')}, commit: () => blank(side, 'absent'), discard: noop};
    const owner = side.document;
    const stale = () => !current(requestTicket) || side.document !== owner;
    let pdf;
    try {
      pdf = await acquire(side);
    } catch (error) {
      if (stale()) throw cancelledError();
      stats.loadFailures++;
      return {result: {...base, state: 'error', error: error?.message || String(error), text: '', focus: unavailable('error')}, commit: () => blank(side, ''), discard: noop};
    }
    if (stale()) throw cancelledError();
    const totalPages = Number.isSafeInteger(pdf?.numPages) && pdf.numPages >= 0 ? pdf.numPages : 0;
    const info = {...base, totalPages};
    if (pageIndex >= totalPages) {
      stats.outOfRange++;
      return {result: {...info, state: 'out-of-range', text: '', focus: unavailable('out-of-range')}, commit: () => blank(side, `${owner.pdfHash}:missing`), discard: noop};
    }
    const key = `${owner.pdfHash}:${pageIndex}`;
    const canvas = canvases[side.name];
    const needsPaint = Boolean(canvas) && side.painted !== key;
    if (!needsPaint && textCache.has(key)) {
      stats.renderReuses++;
      const text = await extractText(null, key);
      const size = canvas ? {width: canvas.width, height: canvas.height} : {};
      const focusResult = sideFocus(side, focus, 'ready', pageIndex, side.paintedDisplay, canvas ? size : null);
      return {result: {...info, state: 'ready', reused: true, ...size, text, focus: focusResult}, commit: () => applyMarker(side, focusResult), discard: noop};
    }
    const page = await pdf.getPage(pageIndex + 1);
    let scratch = null;
    try {
      if (stale()) throw cancelledError();
      let width = canvas?.width, height = canvas?.height;
      let display = side.paintedDisplay;
      if (needsPaint) {
        const viewport = page.getViewport({scale: renderScale});
        width = Math.max(1, Math.ceil(viewport.width));
        height = Math.max(1, Math.ceil(viewport.height));
        display = {width: viewport.width / renderScale, height: viewport.height / renderScale};
        scratch = createScratch ? createScratch() : null;
        if (!scratch) throw new Error('No canvas factory available for preview rendering');
        scratch.width = width;
        scratch.height = height;
        const task = page.render({canvasContext: scratch.getContext('2d'), canvas: scratch, viewport});
        stats.pageRenders++;
        activeTasks.add(task);
        try {
          await task.promise;
        } catch (error) {
          if (isCancellation(error) || stale()) throw cancelledError();
          throw error;
        } finally {
          activeTasks.delete(task);
        }
        if (stale()) throw cancelledError();
      } else {
        stats.renderReuses++;
      }
      const text = await extractText(page, key);
      if (stale()) throw cancelledError();
      const rendered = scratch;
      scratch = null;
      const focusResult = sideFocus(side, focus, 'ready', pageIndex, display, canvas ? {width, height} : null);
      const commit = () => {
        if (!rendered) { applyMarker(side, focusResult); return; }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(rendered, 0, 0);
        if (canvas.dataset) {
          canvas.dataset.pdfHash = owner.pdfHash;
          canvas.dataset.pageIndex = String(pageIndex);
          canvas.dataset.scale = String(renderScale);
          delete canvas.dataset.focusBbox;
        }
        // The fresh page has no outline; keep the clean render as the marker base.
        dropMarker(side);
        side.painted = key;
        side.paintedDisplay = display;
        stats.paints++;
        if (focusResult?.state === 'drawn') side.base = rendered; else freeScratch(rendered);
        applyMarker(side, focusResult);
      };
      return {result: {...info, state: 'ready', reused: !needsPaint, width, height, text, focus: focusResult}, commit, discard: () => freeScratch(rendered)};
    } catch (error) {
      if (!isCancellation(error) && !stale()) {
        return {result: {...info, state: 'error', error: error?.message || String(error), text: ''}, commit: () => blank(side, ''), discard: noop};
      }
      throw error;
    } finally {
      freeScratch(scratch);
      try { page.cleanup?.(); } catch { /* cleanup is best effort */ }
    }
  }

  function setDocuments({original = null, candidate = null} = {}) {
    if (disposed) return Promise.reject(new Error('Preview controller disposed'));
    let next;
    try {
      next = {original: validateDocument(original, 'original'), candidate: validateDocument(candidate, 'candidate')};
    } catch (error) {
      return Promise.reject(error);
    }
    const epoch = ++documentsEpoch;
    supersede();
    const verify = (async () => {
      for (const name of SIDES) {
        const value = next[name];
        if (!value) continue;
        const actual = await sha256Hex(value.pdfBytes);
        if (actual !== value.pdfHash) {
          const error = new Error(`${name} PDF bytes do not match pdfHash`);
          error.code = 'pdf-hash-mismatch';
          throw error;
        }
      }
      if (disposed || epoch !== documentsEpoch) return {status: 'superseded'};
      for (const name of SIDES) {
        const side = sides[name];
        const value = next[name];
        if ((side.document?.pdfHash || null) === (value?.pdfHash || null)) {
          if (value) side.document = value;
          continue;
        }
        releaseSide(side);
        side.document = value;
        wipe(side);
      }
      status('idle', {original: sides.original.document?.pdfHash || null, candidate: sides.candidate.document?.pdfHash || null});
      return {status: 'ready', original: sides.original.document?.pdfHash || null, candidate: sides.candidate.document?.pdfHash || null};
    })();
    documentsReady = verify.then(() => {}, () => {});
    return verify;
  }

  async function show({originalPageIndex = 0, candidatePageIndex = 0, focus} = {}) {
    const pages = {
      original: validatePageIndex(originalPageIndex, 'originalPageIndex'),
      candidate: validatePageIndex(candidatePageIndex, 'candidatePageIndex'),
    };
    const requestedFocus = normalizeFocus(focus);
    if (disposed) return {status: 'disposed'};
    stats.renderRequests++;
    supersede();
    const requestTicket = ticket;
    inflight = requestTicket;
    const requestId = requestTicket;
    await documentsReady;
    if (!current(requestTicket)) { stats.staleDiscards++; return {status: 'cancelled', requestId}; }
    status(SIDES.some(n => sides[n].document && !sides[n].docPromise) ? 'loading' : 'rendering', {requestId});
    const settled = await Promise.allSettled(SIDES.map(name => prepareSide(sides[name], pages[name], requestTicket, requestedFocus)));
    if (!current(requestTicket) || settled.some(r => r.status === 'rejected' && isCancellation(r.reason))) {
      for (const r of settled) if (r.status === 'fulfilled') r.value.discard();
      stats.staleDiscards++;
      return {status: 'cancelled', requestId};
    }
    inflight = null;
    const result = {status: 'ready', requestId};
    for (const [i, name] of SIDES.entries()) {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        r.value.commit();
        result[name] = r.value.result;
      } else {
        blank(sides[name], '');
        result[name] = {pageIndex: pages[name], totalPages: 0, pdfHash: sides[name].document?.pdfHash || null, state: 'error', error: r.reason?.message || String(r.reason), text: '',
          focus: sideFocus(sides[name], requestedFocus, 'error', pages[name])};
      }
    }
    const states = SIDES.map(n => result[n].state);
    if (states.includes('error')) result.status = states.every(s => s === 'error' || s === 'absent') ? 'error' : 'partial';
    else if (states.includes('out-of-range')) result.status = 'partial';
    const meta = {
      requestId,
      status: result.status,
      originalPageIndex: result.original.pageIndex,
      candidatePageIndex: result.candidate.pageIndex,
      originalTotalPages: result.original.totalPages,
      candidateTotalPages: result.candidate.totalPages,
      original: sideMeta(result.original),
      candidate: sideMeta(result.candidate),
    };
    if (requestedFocus) meta.focus = focusMeta(requestedFocus, result);
    notify(onPage, meta);
    notify(onText, {
      requestId,
      original: textMeta(result.original),
      candidate: textMeta(result.candidate),
    });
    status(result.status, {requestId});
    return {...meta, original: {...meta.original, text: result.original.text}, candidate: {...meta.candidate, text: result.candidate.text}};
  }

  function sideMeta(side) {
    const out = {pageIndex: side.pageIndex, totalPages: side.totalPages, pdfHash: side.pdfHash, state: side.state};
    if (side.width !== undefined) { out.width = side.width; out.height = side.height; }
    if (side.reused !== undefined) out.reused = side.reused;
    if (side.error) out.error = side.error;
    return out;
  }

  function focusMeta(requested, result) {
    if (requested.state === 'invalid') return {document: requested.document, state: 'invalid'};
    const side = result[requested.document]?.focus;
    return side ? {...side} : {document: requested.document, state: 'unavailable'};
  }

  function textMeta(side) {
    if (side.state === 'absent') return null;
    return {pdfHash: side.pdfHash, pageIndex: side.pageIndex, totalPages: side.totalPages, state: side.state, text: side.text || ''};
  }

  function cancel() {
    if (disposed) return;
    supersede();
    status('cancelled');
  }

  function dispose() {
    if (disposed) return;
    supersede();
    disposed = true;
    documentsEpoch++;
    for (const name of SIDES) {
      releaseSide(sides[name]);
      wipe(sides[name]);
    }
    textCache.clear();
    try { cache.dispose?.(); } catch { /* best effort */ }
    status('disposed');
  }

  function getStats() {
    return {
      ...stats,
      activeRenderTasks: activeTasks.size,
      loadedDocuments: typeof cache.size === 'number' ? cache.size : undefined,
      disposed,
    };
  }

  async function findCorrespondingPage({from='candidate',pageIndex=0}={}) {
    if(!SIDES.includes(from))throw new TypeError('Choose original or candidate');
    validatePageIndex(pageIndex,'pageIndex');await documentsReady;
    const at=ticket,epoch=documentsEpoch,to=from==='candidate'?'original':'candidate';
    if(disposed||!sides[from].document||!sides[to].document)return {status:'missing'};
    const check=()=>{if(disposed||ticket!==at||documentsEpoch!==epoch)throw cancelledError();};
    const [source,target]=await Promise.all([acquire(sides[from]),acquire(sides[to])]);check();
    if(pageIndex>=source.numPages)return {status:'missing'};
    const words=value=>value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
    const grams=value=>{const w=words(value),set=new Set();for(let i=0;i+2<w.length;i++)set.add(w.slice(i,i+3).join(' '));return set;};
    const page=await source.getPage(pageIndex+1),sourceText=await extractText(page,sides[from].document.pdfHash+':match:'+pageIndex);check();
    const terms=grams(sourceText),exact=sourceText.replace(/\s+/g,' ').trim();if(!exact||terms.size<3)return {status:'missing'};
    const scores=[];
    for(let i=0;i<Math.min(target.numPages,500);i++){
      check();const p=await target.getPage(i+1),text=await extractText(p,sides[to].document.pdfHash+':match:'+i);check();const other=grams(text);let common=0;for(const word of terms)if(other.has(word))common++;
      scores.push({pageIndex:i,score:text.replace(/\s+/g,' ').trim()===exact?1:common/Math.max(terms.size,other.size,1)});
      if(i%8===7)await new Promise(resolve=>setTimeout(resolve,0));
    }
    scores.sort((a,b)=>b.score-a.score);const best=scores[0],second=scores[1];
    if(!best||best.score<0.45)return {status:'missing',searchedPages:scores.length};
    if(second&&best.score-second.score<0.1)return {status:'ambiguous',candidates:scores.filter(s=>best.score-s.score<0.1),searchedPages:scores.length};
    return {status:'matched',document:to,...best,searchedPages:scores.length};
  }
  return {setDocuments, show, cancel, dispose, getStats,findCorrespondingPage};
}
