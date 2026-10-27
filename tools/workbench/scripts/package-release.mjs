// Source releases from an exact clean committed tree. Only named, hash-pinned
// browser runtimes ship; private research, generated profiles and config do not.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Vendored browser PDF.js WASM is licensed shipped runtime, not a private editor candidate.
export const PDFJS_WASM = Object.freeze([
  'app/dist/vendor/wasm/jbig2.wasm',
  'app/dist/vendor/wasm/openjpeg.wasm',
  'app/dist/vendor/wasm/qcms_bg.wasm',
  'app/dist/vendor/wasm/quickjs-eval.wasm',
]);
// Official npm mupdf@1.28.1 browser WASM only. Not the patched falsify-pdf-editor candidate.
export const MUPDF_WASM = 'app/dist/browser-pdf-vendor/mupdf-wasm.wasm';
export const MUPDF_VERSION = '1.28.1';
export const MUPDF_LICENSE = 'AGPL-3.0-or-later';
export const MUPDF_WASM_SHA256 = '5a30ef7b027f541ea8fc54e7c73f16414b0b59940741a12efe5e55f1fd0a99d7';
export const MUPDF_WASM_BYTES = 10409826;
export const PARAGRAPH_WASM = Object.freeze([
  'app/src/paragraph-vendor/runtime/editcore.wasm',
  'app/dist/paragraph-vendor/editcore.wasm',
]);
export const PARAGRAPH_WASM_SHA256 = '9b14b88937a9b21697565df94e82b28ac645547413606d4994d50d9200529c6e';
export const PARAGRAPH_JS_SHA256 = '6e6989a9994715951720e05355111aca7eab898e92b519ebea160167875bb3eb';
export const PARAGRAPH_WASM_BYTES = 7338382;
export const RECOMPOSITION_WASM = 'app/dist/recomposition-vendor/typst_ts_web_compiler_bg.wasm';
export const RECOMPOSITION_WASM_SHA256 = '1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd';

const forbidden = /(?:^|\/)(?:\.venv|\.local|node_modules|\.pdf-editor\.local\.json|\.runtime[^/]*|output|tmp)(?:\/|$)|^experiments\/|\.(?:pdf|docx|wav|mp3|wasm)$/i;
const pdfjsWasm = new Set(PDFJS_WASM);
// Two-sentence synthetic handoff fixture; user papers remain excluded.
const HANDOFF_FIXTURE = 'app/tests/fixtures/handoff-paper.pdf';
const HANDOFF_FIXTURE_SHA256 = 'b518af142de7f30099d55a8125f9ae0e742ddefd403919106ed14b237822a275';

export function unexpectedReleasePaths(tracked) {
  return tracked.filter(p => forbidden.test(p) && !pdfjsWasm.has(p) && p !== MUPDF_WASM && p !== RECOMPOSITION_WASM && p !== HANDOFF_FIXTURE && !PARAGRAPH_WASM.includes(p) && p !== 'experiments/selfplay_codex.py');
}

export function verifyRecompositionRuntime(rootDir) {
  const vendor = join(rootDir, 'app/dist/recomposition-vendor');
  const manifest = readJson(join(vendor, 'manifest.json'));
  if (manifest.version !== 'falsify.recomposition-runtime.v1' || manifest.compilerModule !== '../recomposition-typst.mjs'
      || manifest.wasm?.url !== 'typst_ts_web_compiler_bg.wasm' || manifest.wasm.sha256 !== RECOMPOSITION_WASM_SHA256
      || !Array.isArray(manifest.fonts) || manifest.fonts.length !== 12) throw new Error('Recomposition runtime manifest differs from the pinned compiler and font set.');
  const names = new Set();
  for (const asset of [manifest.wasm, ...manifest.fonts]) {
    if (!/^[A-Za-z0-9_-]+\.(?:wasm|ttf)$/.test(asset.url) || names.has(asset.url)
        || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid recomposition asset.');
    names.add(asset.url);
    if (createHash('sha256').update(readFileSync(join(vendor, asset.url))).digest('hex') !== asset.sha256) throw new Error('Recomposition asset digest mismatch: ' + asset.url);
  }
  if (!readFileSync(join(vendor, 'LICENSE_TYPST_APACHE'), 'utf8').includes('Apache License')
      || !readFileSync(join(vendor, 'notoserif-OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE')
      || !readFileSync(join(vendor, 'notosans-OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE')
      || !readFileSync(join(vendor, 'LICENSE_LIBERATION'), 'utf8').includes('LIBERATION FONT SOFTWARE')) throw new Error('Recomposition licenses are missing.');
  for (const name of ['paper-recompose-runtime.mjs', 'paper-recompose-worker.mjs', 'paper-recompose-worker-core.mjs', 'recomposition-typst.mjs']) readFileSync(join(rootDir, 'app/dist', name));
  return {compilerVersion: '0.7.0', wasmSha256: RECOMPOSITION_WASM_SHA256, fonts: manifest.fonts.length};
}

export function verifyParagraphRuntime(rootDir) {
  for (const rel of PARAGRAPH_WASM) {
    const directory = dirname(join(rootDir, rel));
    const manifest = readJson(join(directory, 'candidate-manifest.json'));
    if (manifest.schema !== 'falsify-editor-candidate-runtime/1'
        || manifest.artifacts?.wasm?.sha256 !== PARAGRAPH_WASM_SHA256
        || manifest.artifacts?.js?.sha256 !== PARAGRAPH_JS_SHA256) throw new Error('Paragraph runtime manifest is not the pinned candidate.');
    for (const [name, expected] of [['editcore.wasm', PARAGRAPH_WASM_SHA256], ['editcore.js', PARAGRAPH_JS_SHA256]]) {
      const bytes = readFileSync(join(directory, name));
      if (createHash('sha256').update(bytes).digest('hex') !== expected
          || name.endsWith('.wasm') && bytes.length !== PARAGRAPH_WASM_BYTES) throw new Error('Paragraph runtime bytes do not match pinned candidate: ' + name);
    }
  }
  for (const rel of ['app/src/paragraph-vendor', 'app/dist/paragraph-vendor']) {
    const notice = readFileSync(join(rootDir, rel, 'NOTICE.md'), 'utf8');
    const license = readFileSync(join(rootDir, rel, 'LICENSE'), 'utf8');
    if (!notice.includes('AGPL') || !notice.includes('candidate-manifest.json')
        || !license.includes('AFFERO GENERAL PUBLIC LICENSE')) throw new Error('Paragraph runtime source and license notices are required.');
  }
  return {wasmSha256: PARAGRAPH_WASM_SHA256, jsSha256: PARAGRAPH_JS_SHA256, sourceBuildVerified: false};
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`MuPDF vendor manifest is missing or not JSON: ${path}`); }
}

export function verifyVendoredMupdfWasm(rootDir) {
  const vendor = join(rootDir, 'app/dist/browser-pdf-vendor');
  const manifest = readJson(join(vendor, 'manifest.json'));
  if (manifest.schema !== 'falsify.browser-pdf.vendor.v1' || manifest.engine !== 'mupdf.js') {
    throw new Error('MuPDF vendor manifest schema or engine is not the pinned browser package.');
  }
  if (manifest.version !== MUPDF_VERSION || manifest.license !== MUPDF_LICENSE) {
    throw new Error(`MuPDF vendor must be ${MUPDF_VERSION} ${MUPDF_LICENSE}.`);
  }
  for (const field of ['npm', 'source', 'correspondingSource']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].includes(MUPDF_VERSION)) {
      throw new Error(`MuPDF vendor ${field} is not pinned to ${MUPDF_VERSION}.`);
    }
  }
  const entry = manifest.files && manifest.files['mupdf-wasm.wasm'];
  if (!entry || entry.sha256 !== MUPDF_WASM_SHA256 || entry.bytes !== MUPDF_WASM_BYTES) {
    throw new Error('MuPDF manifest SHA-256 is not the pinned 1.28.1 mupdf-wasm.wasm digest.');
  }
  const notice = readFileSync(join(vendor, 'NOTICE.md'), 'utf8');
  if (!notice.includes(MUPDF_VERSION) || !notice.includes('mupdf-wasm.wasm') || !/AGPL|Affero General Public License/.test(notice)) {
    throw new Error('MuPDF NOTICE.md must name 1.28.1, mupdf-wasm.wasm, and the AGPL.');
  }
  const license = readFileSync(join(rootDir, 'LICENSE'), 'utf8');
  if (!/AGPL-3\.0|AFFERO GENERAL PUBLIC LICENSE/.test(license)) {
    throw new Error('Workbench LICENSE must remain the AGPL notice paired with the MuPDF vendor.');
  }
  const bytes = readFileSync(join(vendor, 'mupdf-wasm.wasm'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== MUPDF_WASM_BYTES || sha256 !== MUPDF_WASM_SHA256) {
    throw new Error('mupdf-wasm.wasm bytes do not match the pinned 1.28.1 manifest digest.');
  }
  return { version: MUPDF_VERSION, license: MUPDF_LICENSE, sha256, bytes: bytes.length };
}

export function assertShippableSource(tracked, rootDir) {
  const bad = unexpectedReleasePaths(tracked);
  if (bad.length) throw new Error(`Unexpected private/binary paths in source release: ${bad.join(', ')}`);
  if (tracked.includes(HANDOFF_FIXTURE) && createHash('sha256').update(readFileSync(join(rootDir, HANDOFF_FIXTURE))).digest('hex') !== HANDOFF_FIXTURE_SHA256) throw new Error('Synthetic handoff fixture digest mismatch.');
  if (tracked.includes(RECOMPOSITION_WASM)) verifyRecompositionRuntime(rootDir);
  if (PARAGRAPH_WASM.some(p => tracked.includes(p))) {
    if (!PARAGRAPH_WASM.every(p => tracked.includes(p))) throw new Error('Paragraph runtime requires both source and shipped WASM.');
    verifyParagraphRuntime(rootDir);
  }
  if (tracked.includes(MUPDF_WASM)) return verifyVendoredMupdfWasm(rootDir);
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out-dir' || !isAbsolute(args[1])) {
    throw new Error('Usage: node scripts/package-release.mjs --out-dir ABSOLUTE_DIRECTORY');
  }
  const git = (...argv) => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', windowsHide: true }).trim();
  if (git('status', '--porcelain')) throw new Error('Release requires a clean tracked/untracked working tree.');
  const commit = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid commit identity.');
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error('Invalid release version.');
  const pkg = JSON.parse(readFileSync(join(root, 'app/package.json'), 'utf8'));
  const companion = readFileSync(join(root, 'app/local/build_info.py'), 'utf8');
  if (pkg.version !== version || !companion.includes(`WORKBENCH_VERSION = '${version}'`)
      && !companion.includes(`WORKBENCH_VERSION='${version}'`)
      && !companion.includes(`WORKBENCH_VERSION = "${version}"`)) throw new Error('App, companion and release versions differ.');
  const entry = readFileSync(join(root, 'app/dist/index.html'), 'utf8');
  const assetVersions = [...entry.matchAll(/(?:src|href)="[^"\s]+\?v=([^"\s]+)"/g)].map(m => m[1]);
  if (!assetVersions.length || assetVersions.some(v => v !== version)) throw new Error('Update versioned entry asset URLs to the release VERSION.');
  const tracked = git('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean);
  assertShippableSource(tracked, root);
  const directory = resolve(args[1]);
  mkdirSync(directory, { recursive: true });
  const name = `falsify-workbench-v${version}.zip`;
  const archive = join(directory, name);
  execFileSync('git', ['-C', root, 'archive', '--format=zip', `--prefix=falsify-workbench-v${version}/`, '-o', archive, commit], { windowsHide: true });
  const bytes = readFileSync(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const receipt = { schema: 'falsify.source-release.v1', version, commit,
    repository: 'https://github.com/Shinick-Han/falsify-workbench', sourceOnly: true,
    includesPrivatePapers: false, includesPatchedEditorWasm: tracked.includes(PARAGRAPH_WASM[1]),
    ...(tracked.includes(PARAGRAPH_WASM[1]) ? {paragraphRuntime: verifyParagraphRuntime(root)} : {}),
    archive: name, bytes: bytes.length, sha256 };
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(directory, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
  console.log(JSON.stringify(receipt));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) main();
