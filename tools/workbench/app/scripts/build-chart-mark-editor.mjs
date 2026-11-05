import {build, version} from 'esbuild';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EDITOR_CSS} from '../src/chart-mark-editor.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(app, 'dist/chart-mark-editor.js');
const cssFile = resolve(app, 'dist/chart-mark-editor.css');

if (version !== '0.28.2') throw new Error('chart mark editor build requires esbuild 0.28.2');
mkdirSync(resolve(app, 'dist'), {recursive: true});
await build({
  entryPoints: [resolve(app, 'src/chart-mark-editor.mjs')],
  outfile,
  bundle: true,
  format: 'iife',
  globalName: 'FalsifyChartMarkEditor',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  legalComments: 'inline',
  charset: 'utf8',
  banner: {
    js: '/* FalsifyChartMarkEditor. Pointer-event bar and scatter editor. No runtime network. Mount with FalsifyChartMarkEditor.create({host, scene, core, onChange, onCommit, onRequestExport}). */',
  },
});
const js = readFileSync(outfile, 'utf8');
if (js.includes('sourceMappingURL')) throw new Error('mark editor bundle references a source map');
if (/\bfetch\s*\(/.test(js) || js.includes('XMLHttpRequest') || js.includes('new WebSocket') || js.includes('sendBeacon')) {
  throw new Error('mark editor bundle must not call the network');
}
if (js.includes('chart.js') || js.includes('Chart.js')) throw new Error('mark editor bundle must not include Chart.js');
writeFileSync(cssFile, EDITOR_CSS);
console.log('Chart mark editor ' + Buffer.byteLength(js) + ' bytes, css ' + Buffer.byteLength(EDITOR_CSS) + ' bytes');
