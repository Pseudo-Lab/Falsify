const url = new URL('./paper-recompose-runtime.mjs', import.meta.url);
url.search = new URL(import.meta.url).search;
const runtime = await import(url.href);
globalThis.FalsifyRecompositionPdf = Object.freeze({
  prepare: request => runtime.prepare({...request, layoutMode: request?.layoutMode === undefined ? 'measured-continuous' : request.layoutMode}),
});
document.dispatchEvent(new Event('falsify:recomposition-ready'));
