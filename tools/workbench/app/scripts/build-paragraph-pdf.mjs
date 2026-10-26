import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(app, 'src/paragraph-vendor');
const vendor = join(app, 'dist/paragraph-vendor');
mkdirSync(vendor, {recursive: true});
const manifest = JSON.parse(readFileSync(join(source, 'runtime/candidate-manifest.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [kind, expected] of Object.entries(manifest.artifacts)) {
  const bytes = readFileSync(join(source, 'runtime', expected.path));
  if (digest(bytes) !== expected.sha256) throw new Error('Runtime digest mismatch: ' + kind);
  writeFileSync(join(vendor, expected.path), bytes);
}
writeFileSync(join(vendor, 'package.json'), '{"private":true,"type":"module"}\n');
copyFileSync(join(source, 'runtime/candidate-manifest.json'), join(vendor, 'candidate-manifest.json'));
for (const name of ['NOTICE.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.json', 'overlay.json', 'licenses', 'patches', 'build-source']) cpSync(join(source, name), join(vendor, name), {recursive: true});
const modules = ['editor.mjs', 'quality.mjs', 'pagination.mjs', 'inline-preservation.mjs', 'continuation-template.mjs',
  'document-flow.mjs', 'document-flow-band.mjs', 'document-flow-links.mjs', 'document-flow-underlines.mjs'];
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify({
  schema: 'falsify.paragraph-pdf.vendor.v1', license: 'AGPL-3.0-only',
  sourceModuleBase: 'cd4ba2cdd68ae7e51198f615bd4ac6130206b162',
  sourceModuleOverlay: JSON.parse(readFileSync(join(source, 'overlay.json'), 'utf8')),
  upstream: manifest.upstream, sourcePatches: manifest.sourcePatches,
  artifacts: manifest.artifacts, sourceBuildVerified: false,
  trust: 'locally-supplied-hash-verified-artifacts',
  editorModuleSha256: Object.fromEntries(modules.map(name => [name, digest(readFileSync(join(source, name)))])),
  provenance: 'Runtime bytes match caller-supplied candidate digests; build from listed C++ sources/patches is not verified. Editor-module overlay, if any, must accompany source distribution.',
}, null, 2) + '\n');
const plugin = {
  name: 'paragraph-browser-adaptations',
  setup(build) {
    build.onResolve({filter: /^\.\/browser-pdf-vendor\/mupdf\.js$/}, () => ({path: './browser-pdf-vendor/mupdf.js', external: true}));
    build.onResolve({filter: /^node:crypto$/}, () => ({path: join(app, 'src/paragraph-pdf-crypto.mjs')}));
    build.onResolve({filter: /^\.\/runtime\.mjs$/}, args => args.importer.replaceAll('\\', '/').endsWith('paragraph-vendor/editor.mjs') ? ({path: join(app, 'src/paragraph-pdf-runtime.mjs')}) : undefined);
    build.onResolve({filter: /^\.\/engine-loader\.js$/}, () => ({path: join(app, 'src/paragraph-pdf-engine-loader.mjs')}));
    build.onResolve({filter: /freetext-script$/}, () => ({path: join(source, 'utils/freetext-script.ts')}));
  },
};
for (const name of ['paragraph-pdf', 'paragraph-pdf-worker']) {
  const result = await build({entryPoints: [join(app, `src/${name}.mjs`)], outfile: join(app, `dist/${name}.mjs`), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'eof', metafile: true, plugins: [plugin]});
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(p => p.includes('node_modules') || /runtime\.mjs$/.test(p) && !p.includes('paragraph-pdf-runtime'))) throw new Error('Unexpected browser dependency');
}
copyFileSync(join(app, 'src/paragraph-pdf-loader.js'), join(app, 'dist/paragraph-pdf.js'));
console.log('paragraph-pdf built; local candidate hash verified; source build not verified');
