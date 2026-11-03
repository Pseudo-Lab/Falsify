import {build, version} from 'esbuild';
import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(app, 'vendor-sources/chart-redraw');
const out = resolve(app, 'dist/chart-redraw-vendor');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const upstream = JSON.parse(readFileSync(resolve(source, 'UPSTREAM.json'), 'utf8'));

if (version !== '0.28.2') throw new Error('chart redraw build requires esbuild 0.28.2');
for (const group of [upstream.chartJs, upstream.errorBars]) {
  for (const file of group.files) {
    const bytes = readFileSync(resolve(source, file.path));
    if (sha(bytes) !== file.sha256) throw new Error('Pinned chart source mismatch: ' + file.path);
  }
}
const font = readFileSync(resolve(app, upstream.font.path));
if (sha(font) !== upstream.font.sha256) throw new Error('Pinned chart font mismatch');
const license = readFileSync(resolve(source, upstream.font.licensePath));
if (sha(license) !== upstream.font.licenseSha256) throw new Error('Pinned chart font license mismatch');

function stripMap(text) {
  return text.replace(/(?:\r?\n)?\/\/# sourceMappingURL=\S+\s*$/u, '\n');
}

const chart = stripMap(readFileSync(resolve(source, 'chart.js/chart.umd.js'), 'utf8'));
const errors = stripMap(readFileSync(resolve(source, 'chartjs-chart-error-bars/index.umd.js'), 'utf8'));
const adapter = await build({
  entryPoints: [resolve(source, 'adapter.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  legalComments: 'inline',
  charset: 'utf8',
});
const adapterText = adapter.outputFiles[0].text;
const header = '/* FalsifyChartRedraw. Chart.js 4.6.1 MIT, including its bundled @kurkle/color dependency. chartjs-chart-error-bars 4.4.5 MIT, Copyright 2019-2023 Samuel Gratzl. Latin Modern Roman 7 embedded for axis text, GUST Font License. Full licenses: dist/chart-redraw-vendor/. No runtime network. */\n';
const runtime = header + `'use strict';
(function () {
  const savedChart = Object.prototype.hasOwnProperty.call(globalThis, 'Chart');
  const previousChart = globalThis.Chart;
  const savedErrors = Object.prototype.hasOwnProperty.call(globalThis, 'ChartErrorBars');
  const previousErrors = globalThis.ChartErrorBars;
  globalThis.__FALSIFY_CHART_FONT_BASE64__ = ${JSON.stringify(font.toString('base64'))};
  try {
    (function (exports, module, define) {
${chart}
${errors}
    })(undefined, undefined, undefined);
    globalThis.__FalsifyChartRedrawVendor = {Chart: globalThis.Chart, ChartErrorBars: globalThis.ChartErrorBars};
    ${adapterText}
  } finally {
    if (savedChart) globalThis.Chart = previousChart;
    else delete globalThis.Chart;
    if (savedErrors) globalThis.ChartErrorBars = previousErrors;
    else delete globalThis.ChartErrorBars;
    delete globalThis.__FalsifyChartRedrawVendor;
    delete globalThis.__FALSIFY_CHART_FONT_BASE64__;
  }
})();
`;
const bytes = Buffer.from(runtime);
mkdirSync(out, {recursive: true});
writeFileSync(resolve(app, 'dist/paper-chart-redraw.js'), bytes);
copyFileSync(resolve(source, 'chart.js/LICENSE.md'), resolve(out, 'LICENSE-chart.js.md'));
copyFileSync(resolve(source, 'chartjs-chart-error-bars/LICENSE'), resolve(out, 'LICENSE-chartjs-chart-error-bars'));
copyFileSync(resolve(source, 'LICENSE-LM'), resolve(out, 'LICENSE-LM'));
const notice = `Falsify chart redraw
Chart.js ${upstream.chartJs.version}
${upstream.chartJs.repository}
${upstream.chartJs.license}. ${upstream.chartJs.bundledDependency}.
Official distribution ${upstream.chartJs.distribution}, npm integrity ${upstream.chartJs.npmIntegrity}.

chartjs-chart-error-bars ${upstream.errorBars.version}
${upstream.errorBars.repository}
${upstream.errorBars.license}. Copyright 2019-2023 Samuel Gratzl.
Official distribution ${upstream.errorBars.distribution}, peer ${upstream.errorBars.peer}, npm integrity ${upstream.errorBars.npmIntegrity}.
Upstream chart types: line, bar, scatter, lineWithErrorBars, barWithErrorBars, scatterWithErrorBars.
Point fields yMin and yMax carry explicit yLow and yHigh. Sample points are not given error bars.

${upstream.font.family}
${upstream.font.license}. Unmodified font bytes from app/${upstream.font.path}.
SHA-256 ${upstream.font.sha256}. Loaded in the canvas as ${upstream.font.cssFamily}.

Vendored files are unchanged. The browser bundle is app/dist/paper-chart-redraw.js.
Rebuild from app/: node scripts/build-chart-redraw.mjs
esbuild ${version} bundles only the Falsify adapter. It does not rebuild Chart.js.
`;
writeFileSync(resolve(out, 'NOTICE.md'), notice);
const manifest = {
  schema: 'falsify.chart-redraw-runtime.v1',
  esbuild: version,
  pixelRatio: 2,
  runtime: {path: 'dist/paper-chart-redraw.js', bytes: bytes.length, sha256: sha(bytes)},
  upstream,
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (runtime.includes('sourceMappingURL')) throw new Error('chart bundle still references a source map');
console.log('Chart redraw runtime ' + bytes.length + ' bytes ' + sha(bytes));
