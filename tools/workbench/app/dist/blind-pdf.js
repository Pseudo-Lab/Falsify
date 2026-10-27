(function (root) {
  'use strict';
  const script = document.currentScript;
  const target = new URL('./blind-pdf.mjs', script.src);target.search=new URL(script.src).search;
  const url = target.href;
  root.FalsifyBlindPdf = {prepare: async function (options) { return (await import(url)).prepare(options); }};
})(globalThis);
