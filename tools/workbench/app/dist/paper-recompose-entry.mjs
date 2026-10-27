const url = new URL('./paper-recompose-runtime.mjs', import.meta.url);
url.search = new URL(import.meta.url).search;
const runtime = await import(url.href);
globalThis.FalsifyRecompositionPdf = Object.freeze({prepare: runtime.prepare});
document.dispatchEvent(new Event('falsify:recomposition-ready'));
