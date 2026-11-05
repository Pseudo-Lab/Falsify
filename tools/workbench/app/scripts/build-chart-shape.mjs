import {build, version} from 'esbuild';
import {readFileSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(app, 'vendor-sources/chart-shape/ml-peak-shape-generator');
const out = resolve(app, 'dist/chart-shape-vendor');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const upstream = JSON.parse(readFileSync(resolve(source, 'UPSTREAM.json'), 'utf8'));

if (version !== '0.28.2') throw new Error('chart shape build requires esbuild 0.28.2');
if (upstream.commit !== '5a87af23408aedf00e35e43ca6648a20cf6455bd') throw new Error('Pinned peak-shape commit mismatch');
for (const file of upstream.files) {
  const bytes = readFileSync(resolve(source, file.path));
  if (sha(bytes) !== file.sha256) throw new Error('Pinned peak-shape source mismatch: ' + file.path);
}

const banner = `/* FalsifyChartShape. Local deform/move/resize/set-values on falsify.chart-scene.v1.
ml-peak-shape-generator ${upstream.version} (${upstream.license}), ${upstream.repository}
commit ${upstream.commit}. Unmodified Gaussian evaluator; Falsify applies the compact path window.
License: dist/chart-shape-vendor/LICENSE. No runtime network. esbuild ${version}. */`;
const result = await build({
  entryPoints: [resolve(app, 'src/chart-shape-core.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'FalsifyChartShape',
  platform: 'neutral',
  target: 'es2020',
  minify: false,
  legalComments: 'inline',
  charset: 'utf8',
  banner: {js: banner},
});
const bytes = Buffer.from(result.outputFiles[0].contents);
mkdirSync(out, {recursive: true});
writeFileSync(resolve(app, 'dist/chart-shape-core.js'), bytes);
copyFileSync(resolve(source, 'LICENSE'), resolve(out, 'LICENSE'));
const notice = `Falsify chart shape core
ml-peak-shape-generator ${upstream.version}
${upstream.repository}
Commit ${upstream.commit}
${upstream.license}. Copyright (c) 2021 mljs.
Vendored files are unchanged and listed with sha256 in vendor-sources/chart-shape/ml-peak-shape-generator/UPSTREAM.json.
The needed core is the 1D Gaussian evaluator. Falsify's adapter windows that profile to a finite path radius.
esbuild ${version}. The bundle is app/dist/chart-shape-core.js.
`;
writeFileSync(resolve(out, 'NOTICE.md'), notice);
const manifest = {
  schema: 'falsify.chart-shape-runtime.v1',
  upstream,
  esbuild: version,
  bundle: {path: 'chart-shape-core.js', bytes: bytes.length, sha256: sha(bytes)},
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('chart shape runtime ' + bytes.length + ' bytes ' + sha(bytes));
