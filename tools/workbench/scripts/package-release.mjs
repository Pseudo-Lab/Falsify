// Source-only release artifacts from an exact clean committed tree. Never packages local research/runtime/config.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const forbidden = /(?:^|\/)(?:\.venv|\.local|node_modules|\.pdf-editor\.local\.json|\.runtime[^/]*|output|tmp)(?:\/|$)|^experiments\/|\.(?:pdf|docx|wav|mp3|wasm)$/i;
const tracked = git('ls-tree', '-r', '--name-only', commit).split('\n');
// Vendored browser PDF.js WASM is licensed shipped source runtime, not our private editor candidate.
const shippedWasm = new Set(['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm', 'quickjs-eval.wasm']
  .map(name => `app/dist/vendor/wasm/${name}`));
const bad = tracked.filter(p => forbidden.test(p) && !shippedWasm.has(p) && p !== 'experiments/selfplay_codex.py');
if (bad.length) throw new Error(`Unexpected private/binary paths in source release: ${bad.join(', ')}`);
const directory = resolve(args[1]);
mkdirSync(directory, { recursive: true });
const name = `falsify-workbench-v${version}.zip`;
const archive = join(directory, name);
execFileSync('git', ['-C', root, 'archive', '--format=zip', `--prefix=falsify-workbench-v${version}/`, '-o', archive, commit], { windowsHide: true });
const bytes = readFileSync(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const receipt = { schema: 'falsify.source-release.v1', version, commit,
  repository: 'https://github.com/Shinick-Han/falsify-workbench', sourceOnly: true,
  includesPrivatePapers: false, includesPatchedEditorWasm: false, archive: name, bytes: bytes.length, sha256 };
writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
writeFileSync(join(directory, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
console.log(JSON.stringify(receipt));
