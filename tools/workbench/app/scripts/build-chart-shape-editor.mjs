import {build, version} from 'esbuild';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EDITOR_CSS} from '../src/chart-shape-editor.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(app, 'dist/chart-shape-editor.js');
const cssFile = resolve(app, 'dist/chart-shape-editor.css');

if (version !== '0.28.2') throw new Error('chart shape editor build requires esbuild 0.28.2');
mkdirSync(resolve(app, 'dist'), {recursive: true});
await build({
  entryPoints: [resolve(app, 'src/chart-shape-editor.mjs')],
  outfile,
  bundle: true,
  format: 'iife',
  globalName: 'FalsifyChartShapeEditor',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  legalComments: 'inline',
  charset: 'utf8',
  banner: {
    js: '/* FalsifyChartShapeEditor. Pointer-event curve editor. No runtime network. Mount with FalsifyChartShapeEditor.create({host, scene, onChange, onCommit, onRequestExport, core}). */',
  },
});
const js = readFileSync(outfile, 'utf8');
if (js.includes('sourceMappingURL')) throw new Error('shape editor bundle references a source map');
if (/\bfetch\s*\(/.test(js) || js.includes('XMLHttpRequest') || js.includes('new WebSocket') || js.includes('sendBeacon')) {
  throw new Error('shape editor bundle must not call the network');
}
if (js.includes('createFixtureCore') || js.includes('Math.cos')) {
  throw new Error('shape editor bundle must require FalsifyChartShape and must not ship a cosine fixture core');
}
writeFileSync(cssFile, EDITOR_CSS);
console.log('Chart shape editor ' + Buffer.byteLength(js) + ' bytes, css ' + Buffer.byteLength(EDITOR_CSS) + ' bytes');
