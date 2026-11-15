import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  EDITOR_MODULES,
  REASON_EMSDK_NOT_SUPPLIED,
  resolveEditorRepoDir,
  sha256Hex,
  verifyParagraphVendorProvenance,
  verifyWasmSourceBuild,
} from '../scripts/verify-paragraph-vendor-provenance.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_BASE = '8f3bef68aa50364aec79fb19d07887dfed7addee';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function initGitRepo(dir, files, message) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

test('paragraph-vendor provenance, 12 patches, and synced 51ae98a+8f3bef6 modules verify cleanly', () => {
  const editorRepo = resolveEditorRepoDir(appDir);
  const report = verifyParagraphVendorProvenance({
    appDir,
    requireEditorRepo: Boolean(editorRepo),
    verifyWasmBuild: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.patchCount, 12);
  assert.equal(report.modules.sourceModuleBase, EXPECTED_BASE);
  assert.equal(report.sourceBuildVerified, false);
  assert.equal(report.reason, REASON_EMSDK_NOT_SUPPLIED);
  if (editorRepo) {
    assert.equal(report.modules.modulesGitVerified, true);
    assert.equal(report.modules.modules['document-flow-band.mjs'].matchesBaseBlob, true);
    assert.equal(report.modules.modules['document-flow-underlines.mjs'].matchesBaseBlob, true);
    for (const mod of EDITOR_MODULES) {
      assert.equal(report.modules.modules[mod].matchesBasePlusOverlay, true);
    }
  }
  const bandSrc = readFileSync(join(appDir, 'src/paragraph-vendor/document-flow-band.mjs'), 'utf8');
  assert.match(bandSrc, /export function adjacentSourceRuns\(/);
  const underlineSrc = readFileSync(join(appDir, 'src/paragraph-vendor/document-flow-underlines.mjs'), 'utf8');
  assert.match(underlineSrc, /Prove ownership|long decorations/i);
  assert.match(underlineSrc, /right-left>2\*size\+\.02/);
});

test('tampered patch, runtime artifact, or falsified sourceBuildVerified fails verification', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pv-tamper-'));
  try {
    const fakeApp = join(tmp, 'app');
    mkdirSync(join(fakeApp, 'src'), { recursive: true });
    mkdirSync(join(fakeApp, 'dist'), { recursive: true });
    cpSync(join(appDir, 'src/paragraph-vendor'), join(fakeApp, 'src/paragraph-vendor'), { recursive: true });
    cpSync(join(appDir, 'dist/paragraph-vendor'), join(fakeApp, 'dist/paragraph-vendor'), { recursive: true });

    const patchFile = join(fakeApp, 'src/paragraph-vendor/patches/pdfium-stream-order.patch');
    writeFileSync(patchFile, readFileSync(patchFile, 'utf8') + '\n# tampered\n');
    assert.throws(() => verifyParagraphVendorProvenance({ appDir: fakeApp }), /SHA-256 mismatch.*pdfium-stream-order\.patch/);

    cpSync(join(appDir, 'src/paragraph-vendor/patches/pdfium-stream-order.patch'), patchFile);
    const distManifestPath = join(fakeApp, 'dist/paragraph-vendor/manifest.json');
    const distManifest = JSON.parse(readFileSync(distManifestPath, 'utf8'));
    distManifest.sourceBuildVerified = true;
    writeFileSync(distManifestPath, JSON.stringify(distManifest, null, 2));
    assert.throws(() => verifyParagraphVendorProvenance({ appDir: fakeApp }), /must not claim sourceBuildVerified=true/);

    distManifest.sourceBuildVerified = false;
    writeFileSync(distManifestPath, JSON.stringify(distManifest, null, 2));
    writeFileSync(join(fakeApp, 'src/paragraph-vendor/runtime/editcore.wasm'), 'tampered');
    assert.throws(() => verifyParagraphVendorProvenance({ appDir: fakeApp }), /SHA-256 mismatch.*editcore\.wasm/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('git blob + overlay verification catches undeclared local module edits', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pv-git-'));
  try {
    const repoDir = join(tmp, 'editor-repo');
    const baseFiles = Object.fromEntries(EDITOR_MODULES.map((m) => [`src/${m}`, `export const name = '${m}';\n`]));
    const baseSha = initGitRepo(repoDir, baseFiles, 'base');

    const fakeApp = join(tmp, 'app');
    const srcVendor = join(fakeApp, 'src/paragraph-vendor');
    mkdirSync(join(srcVendor, 'runtime'), { recursive: true });
    mkdirSync(join(srcVendor, 'patches'), { recursive: true });
    for (const m of EDITOR_MODULES) writeFileSync(join(srcVendor, m), baseFiles[`src/${m}`]);
    const patchBytes = Buffer.from('', 'utf8');
    writeFileSync(join(srcVendor, 'patches/paragraph-flow-overlay.patch'), patchBytes);
    writeFileSync(join(srcVendor, 'overlay.json'), JSON.stringify({
      schema: 'falsify.paragraph-editor.overlay.v1',
      base: baseSha,
      commit: baseSha,
      branch: 'main',
      repository: 'https://example.invalid/editor',
      patch: 'patches/paragraph-flow-overlay.patch',
      patchSha256: sha256Hex(patchBytes),
    }, null, 2));
    const dummyPatch = Buffer.from('diff --git a/x b/x\n');
    writeFileSync(join(srcVendor, 'patches/dummy.patch'), dummyPatch);
    const dummyJs = Buffer.from('export default 1;\n');
    const dummyWasm = Buffer.from('wasm');
    writeFileSync(join(srcVendor, 'runtime/editcore.js'), dummyJs);
    writeFileSync(join(srcVendor, 'runtime/editcore.wasm'), dummyWasm);
    writeFileSync(join(srcVendor, 'runtime/candidate-manifest.json'), JSON.stringify({
      schema: 'falsify-editor-candidate-runtime/1',
      upstream: { bentopdfCommit: baseSha, engineCommit: baseSha, pdfiumCommit: baseSha },
      toolchain: { emsdk: '3.1.70' },
      sourcePatches: [{ name: 'dummy.patch', sha256: sha256Hex(dummyPatch) }],
      artifacts: {
        js: { path: 'editcore.js', sha256: sha256Hex(dummyJs) },
        wasm: { path: 'editcore.wasm', sha256: sha256Hex(dummyWasm) },
      },
    }, null, 2));

    const ok = verifyParagraphVendorProvenance({ appDir: fakeApp, editorRepoDir: repoDir, requireEditorRepo: true, checkDist: false });
    assert.equal(ok.modules.modulesGitVerified, true);
    assert.equal(ok.sourceBuildVerified, false);

    writeFileSync(join(srcVendor, 'editor.mjs'), "export const name = 'tampered';\n");
    assert.throws(
      () => verifyParagraphVendorProvenance({ appDir: fakeApp, editorRepoDir: repoDir, requireEditorRepo: true, checkDist: false }),
      /Module editor\.mjs differs from/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('wasm build verification stays false unless clean-room build reproduces exact artifact hashes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pv-wasm-'));
  try {
    const engineDir = join(tmp, 'engine');
    const pdfiumDir = join(tmp, 'pdfium');
    const engineCommit = initGitRepo(engineDir, { 'src.cpp': 'int v = 1;\n' }, 'engine');
    const pdfiumCommit = initGitRepo(pdfiumDir, { 'pdf.cpp': 'int p = 1;\n' }, 'pdfium');

    const srcVendor = join(tmp, 'src-vendor');
    mkdirSync(join(srcVendor, 'patches'), { recursive: true });
    const patchContent = [
      'diff --git a/src.cpp b/src.cpp',
      '--- a/src.cpp',
      '+++ b/src.cpp',
      '@@ -1 +1 @@',
      '-int v = 1;',
      '+int v = 2;',
      '',
    ].join('\n');
    writeFileSync(join(srcVendor, 'patches/engine-test.patch'), patchContent);

    const expectedJs = Buffer.from('expected-js-2\n');
    const expectedWasm = Buffer.from('expected-wasm-2\n');
    const manifest = {
      upstream: { bentopdfCommit: engineCommit, engineCommit, pdfiumCommit },
      toolchain: { emsdk: '3.1.70' },
      sourcePatches: [{ name: 'engine-test.patch', sha256: sha256Hex(Buffer.from(patchContent)) }],
      artifacts: {
        js: { path: 'editcore.js', sha256: sha256Hex(expectedJs) },
        wasm: { path: 'editcore.wasm', sha256: sha256Hex(expectedWasm) },
      },
    };

    const fakeEmcc = join(tmp, 'fake-emcc.mjs');
    writeFileSync(fakeEmcc, "console.log('emcc 3.1.70');\n");
    const emccWrapper = [process.execPath, fakeEmcc];

    const noTreeResult = verifyWasmSourceBuild({
      sourceDir: srcVendor,
      manifest,
      verifyWasmBuild: true,
      emccCommand: emccWrapper,
      upstreamEngineDir: join(tmp, 'missing-engine'),
      upstreamPdfiumDir: pdfiumDir,
      buildCommand: [process.execPath, '-e', ''],
    });
    assert.equal(noTreeResult.sourceBuildVerified, false);
    assert.equal(noTreeResult.reason, REASON_EMSDK_NOT_SUPPLIED);

    const buildScript = join(tmp, 'mock-build.mjs');
    writeFileSync(
      buildScript,
      [
        "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "const cpp = readFileSync('engine/src.cpp', 'utf8');",
        "mkdirSync('out', { recursive: true });",
        "const tag = cpp.includes('v = 2') ? '2' : '1';",
        "writeFileSync('out/editcore.js', `expected-js-${tag}\\n`);",
        "writeFileSync('out/editcore.wasm', `expected-wasm-${tag}\\n`);",
      ].join('\n')
    );

    const verified = verifyWasmSourceBuild({
      sourceDir: srcVendor,
      manifest,
      verifyWasmBuild: true,
      emccCommand: emccWrapper,
      upstreamEngineDir: engineDir,
      upstreamPdfiumDir: pdfiumDir,
      buildCommand: [process.execPath, buildScript],
    });
    assert.equal(verified.sourceBuildVerified, true);

    const mismatched = verifyWasmSourceBuild({
      sourceDir: srcVendor,
      manifest: { ...manifest, artifacts: { ...manifest.artifacts, wasm: { path: 'editcore.wasm', sha256: '0'.repeat(64) } } },
      verifyWasmBuild: true,
      emccCommand: emccWrapper,
      upstreamEngineDir: engineDir,
      upstreamPdfiumDir: pdfiumDir,
      buildCommand: [process.execPath, buildScript],
    });
    assert.equal(mismatched.sourceBuildVerified, false);
    assert.equal(mismatched.reason, 'rebuilt-artifact-digest-mismatch');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
