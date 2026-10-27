import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MUPDF_WASM, MUPDF_WASM_SHA256, PDFJS_WASM, PARAGRAPH_WASM, PARAGRAPH_WASM_SHA256,
  assertShippableSource, unexpectedReleasePaths, verifyVendoredMupdfWasm, verifyParagraphRuntime,
  RECOMPOSITION_WASM, RECOMPOSITION_WASM_SHA256, verifyRecompositionRuntime,
} from './package-release.mjs';
import { assertChromeLoaderExecuted, CHROME_TEST } from './assert-browser-pdf-executed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');

test('recomposition compiler, font assets and notices survive source packaging', () => {
  const proof = verifyRecompositionRuntime(root);
  assert.equal(proof.wasmSha256, RECOMPOSITION_WASM_SHA256);
  assert.equal(proof.fonts, 12);
  assert.deepEqual(unexpectedReleasePaths([RECOMPOSITION_WASM]), []);
  assertShippableSource([RECOMPOSITION_WASM], root);
  assert.throws(() => assertShippableSource(['app/dist/recomposition-vendor/arbitrary.wasm'], root), /Unexpected private/);
});

test('pinned MuPDF 1.28.1 wasm matches the vendor manifest and NOTICE', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'app/dist/browser-pdf-vendor/manifest.json'), 'utf8'));
  const bytes = readFileSync(join(root, MUPDF_WASM));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, MUPDF_WASM_SHA256);
  assert.equal(manifest.files['mupdf-wasm.wasm'].sha256, MUPDF_WASM_SHA256);
  assert.equal(manifest.version, '1.28.1');
  assert.deepEqual(verifyVendoredMupdfWasm(root), {
    version: '1.28.1', license: 'AGPL-3.0-or-later', sha256: MUPDF_WASM_SHA256, bytes: bytes.length,
  });
});

test('release paths allow only PDF.js wasm plus the one pinned MuPDF wasm', () => {
  const tracked = [...PDFJS_WASM, MUPDF_WASM, 'app/dist/index.html', 'experiments/selfplay_codex.py'];
  assert.deepEqual(unexpectedReleasePaths(tracked), []);
  assertShippableSource(tracked, root);
  for (const extra of [
    'app/dist/browser-pdf-vendor/other.wasm',
    'app/dist/private.wasm',
    'notes/sample.pdf',
    'app/dist/vendor/wasm/extra.wasm',
    'tmp/build.wasm',
  ]) {
    assert.throws(() => assertShippableSource([...tracked, extra], root), /Unexpected private\/binary paths/);
  }
});

test('a mismatched manifest, digest, or NOTICE is not allowlisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'falsify-pack-'));
  try {
    const vendor = join(dir, 'app/dist/browser-pdf-vendor');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(dir, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\n');
    const wasm = Buffer.from('not-the-pinned-runtime');
    writeFileSync(join(vendor, 'mupdf-wasm.wasm'), wasm);
    const notice = '# MuPDF.js 1.28.1\nAGPL mupdf-wasm.wasm\n';
    writeFileSync(join(vendor, 'NOTICE.md'), notice);
    const base = {
      schema: 'falsify.browser-pdf.vendor.v1', engine: 'mupdf.js', version: '1.28.1', license: 'AGPL-3.0-or-later',
      npm: 'https://www.npmjs.com/package/mupdf/v/1.28.1',
      source: 'https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1',
      correspondingSource: 'https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1',
      files: { 'mupdf-wasm.wasm': { sha256: MUPDF_WASM_SHA256, bytes: 10409826 } },
    };
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(base));
    assert.throws(() => verifyVendoredMupdfWasm(dir), /pinned 1\.28\.1 manifest digest/);
    base.files['mupdf-wasm.wasm'] = { sha256: createHash('sha256').update(wasm).digest('hex'), bytes: wasm.length };
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(base));
    assert.throws(() => verifyVendoredMupdfWasm(dir), /not the pinned 1\.28\.1/);
    base.version = '1.28.0';
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(base));
    assert.throws(() => verifyVendoredMupdfWasm(dir), /1\.28\.1 AGPL-3\.0-or-later/);
    base.version = '1.28.1';
    base.license = 'MIT';
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(base));
    assert.throws(() => verifyVendoredMupdfWasm(dir), /AGPL-3\.0-or-later/);
    base.license = 'AGPL-3.0-or-later';
    base.files['mupdf-wasm.wasm'] = { sha256: MUPDF_WASM_SHA256, bytes: 10409826 };
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(base));
    writeFileSync(join(vendor, 'NOTICE.md'), '# MuPDF.js 1.28.1\nno license name\n');
    assert.throws(() => verifyVendoredMupdfWasm(dir), /NOTICE\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only both exact paragraph runtime files with matching notices are shippable', () => {
  const result = verifyParagraphRuntime(root);
  assert.equal(result.wasmSha256, PARAGRAPH_WASM_SHA256);
  assert.equal(result.sourceBuildVerified, false);
  assertShippableSource([...PARAGRAPH_WASM], root);
  assert.throws(() => assertShippableSource([PARAGRAPH_WASM[0]], root), /both source and shipped/);
  assert.throws(() => assertShippableSource([...PARAGRAPH_WASM, 'app/dist/paragraph-vendor/unknown.wasm'], root), /Unexpected private\/binary/);
});

test('this tree is shippable with the tracked MuPDF wasm and without other binaries', () => {
  const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.equal(tracked.includes(MUPDF_WASM), true);
  assert.equal(unexpectedReleasePaths(tracked).length, 0);
  verifyVendoredMupdfWasm(root);
});

test('workflow_dispatch verifies feature branches and deploys only main', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.match(deploy, /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /needs:\s*\[verify, verify-windows-launcher, verify-macos-arm, verify-macos-intel\]/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  deploy:')), /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.equal((workflow.match(/actions\/deploy-pages@v4/g) || []).length, 1);
});

test('macOS jobs run portable connection tests and do not invent a handler-bundle pass', () => {
  assert.match(workflow, /verify-macos-arm:[\s\S]*runs-on:\s*macos-15\n/);
  assert.match(workflow, /verify-macos-intel:[\s\S]*runs-on:\s*macos-15-intel\n/);
  assert.equal((workflow.match(/bash scripts\/test-posix-connection\.sh/g) || []).length, 2);
  assert.equal((workflow.match(/node-version:\s*'24'/g) || []).length, 4);
  assert.equal((workflow.match(/python-version:\s*'3\.12'/g) || []).length, 4);
  assert.match(workflow, /shell:\s*pwsh/);
  assert.match(workflow, /shell:\s*powershell/);
  assert.match(workflow, /Windows PowerShell 5\.1/);
  assert.equal((workflow.match(/bash scripts\/test-macos-handler\.sh/g) || []).length, 2);
  assert.doesNotMatch(workflow, /handler bundle passed|bundle test: PASS/i);
});

test('MuPDF browser CI installs dependencies before the test and rejects a skip', () => {
  const mupdf = workflow.slice(workflow.indexOf('Browser PDF MuPDF contracts'));
  const npmCi = workflow.indexOf('npm ci --ignore-scripts');
  assert.ok(npmCi >= 0 && npmCi < workflow.indexOf('run: npm test'));
  assert.ok(npmCi < workflow.indexOf('tests/browser-pdf.spec.mjs'));
  assert.match(workflow, /playwright install chromium/);
  assert.match(workflow, /Isolated visual workflow browser dependencies\s*\n\s*timeout-minutes: 5/);
  assert.match(mupdf, /FALSIFY_CHROME_EXECUTABLE/);
  assert.match(mupdf, /assert-browser-pdf-executed\.mjs/);
  assert.throws(() => assertChromeLoaderExecuted(`ok 1 - ${CHROME_TEST} # SKIP playwright is not installed\n`), /skip is not a pass/);
  assert.throws(() => assertChromeLoaderExecuted('ok 1 - something else\n'), /did not run/);
  assert.equal(assertChromeLoaderExecuted(`ok 4 - ${CHROME_TEST}\n`), 1);
  assert.throws(() => assertChromeLoaderExecuted(`not ok 4 - ${CHROME_TEST}\n`), /failed/);
});
