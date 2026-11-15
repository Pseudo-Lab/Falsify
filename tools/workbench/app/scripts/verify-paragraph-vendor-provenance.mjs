import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EDITOR_MODULES = Object.freeze([
  'editor.mjs',
  'quality.mjs',
  'pagination.mjs',
  'inline-preservation.mjs',
  'continuation-template.mjs',
  'document-flow.mjs',
  'document-flow-band.mjs',
  'document-flow-links.mjs',
  'document-flow-underlines.mjs',
]);

export const REASON_EMSDK_NOT_SUPPLIED = 'emsdk-3.1.70-clean-tree-not-supplied';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Compute lowercase SHA-256 hex digest for a Buffer or Uint8Array. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonStrict(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`);
  }
}

function runCommand(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function assertManifestShape(manifest) {
  if (manifest?.schema !== 'falsify-editor-candidate-runtime/1') {
    throw new Error(`Unexpected candidate-manifest schema: ${manifest?.schema}`);
  }
  if (manifest?.toolchain?.emsdk !== '3.1.70') {
    throw new Error(`Unexpected emsdk pin: ${manifest?.toolchain?.emsdk}`);
  }
  for (const key of ['bentopdfCommit', 'engineCommit', 'pdfiumCommit']) {
    if (!HEX40.test(manifest?.upstream?.[key] || '')) {
      throw new Error(`Invalid upstream.${key} commit hash`);
    }
  }
  if (!Array.isArray(manifest?.sourcePatches) || manifest.sourcePatches.length === 0) {
    throw new Error('candidate-manifest.json sourcePatches must be a non-empty array');
  }
}

function verifyFileDigest(filePath, expectedSha256, label) {
  if (!HEX64.test(expectedSha256 || '')) throw new Error(`Invalid expected sha256 for ${label}`);
  if (!existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const bytes = readFileSync(filePath);
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${label}: expected ${expectedSha256}, got ${actual}`);
  }
  return { sha256: actual, bytes: bytes.length };
}

/** Verify runtime JS/WASM and all listed sourcePatches against candidate-manifest.json. */
export function verifyCandidateArtifacts(sourceDir, distVendorDir = null) {
  const manifestPath = join(sourceDir, 'runtime/candidate-manifest.json');
  const manifest = readJsonStrict(manifestPath, 'candidate-manifest.json');
  assertManifestShape(manifest);

  const artifacts = {};
  for (const [kind, spec] of Object.entries(manifest.artifacts || {})) {
    const info = verifyFileDigest(join(sourceDir, 'runtime', spec.path), spec.sha256, `runtime/${spec.path}`);
    artifacts[kind] = { path: spec.path, ...info };
    if (distVendorDir && existsSync(distVendorDir)) {
      verifyFileDigest(join(distVendorDir, spec.path), spec.sha256, `dist/paragraph-vendor/${spec.path}`);
    }
  }

  const patches = manifest.sourcePatches.map((entry) => {
    const info = verifyFileDigest(join(sourceDir, 'patches', entry.name), entry.sha256, `patches/${entry.name}`);
    if (distVendorDir && existsSync(distVendorDir)) {
      verifyFileDigest(join(distVendorDir, 'patches', entry.name), entry.sha256, `dist/patches/${entry.name}`);
    }
    return { name: entry.name, ...info };
  });

  if (distVendorDir && existsSync(distVendorDir)) {
    const srcManifestSha = sha256Hex(readFileSync(manifestPath));
    verifyFileDigest(join(distVendorDir, 'candidate-manifest.json'), srcManifestSha, 'dist/candidate-manifest.json');
  }
  return { manifest, artifacts, patches };
}

function verifyOverlayMetadata(sourceDir) {
  const overlay = readJsonStrict(join(sourceDir, 'overlay.json'), 'overlay.json');
  if (overlay.schema !== 'falsify.paragraph-editor.overlay.v1') {
    throw new Error(`Unexpected overlay.json schema: ${overlay.schema}`);
  }
  if (!HEX40.test(overlay.base || '') || !HEX40.test(overlay.commit || '')) {
    throw new Error('overlay.json base and commit must be 40-hex git SHAs');
  }
  let patchBytes = Buffer.alloc(0);
  if (overlay.patch) {
    const patchPath = join(sourceDir, overlay.patch);
    verifyFileDigest(patchPath, overlay.patchSha256, overlay.patch);
    patchBytes = readFileSync(patchPath);
  }
  return { overlay, patchBytes };
}

function verifyDistVendorManifest(distVendorDir, sourceDir, overlay, moduleHashes) {
  const distManifestPath = join(distVendorDir, 'manifest.json');
  if (!existsSync(distManifestPath)) return null;
  const distManifest = readJsonStrict(distManifestPath, 'dist/paragraph-vendor/manifest.json');
  if (distManifest.sourceBuildVerified !== false) {
    throw new Error(`dist/paragraph-vendor/manifest.json must not claim sourceBuildVerified=${distManifest.sourceBuildVerified}`);
  }
  if (distManifest.sourceModuleBase !== overlay.base) {
    throw new Error(`dist manifest sourceModuleBase (${distManifest.sourceModuleBase}) !== overlay.base (${overlay.base})`);
  }
  if (JSON.stringify(distManifest.sourceModuleOverlay) !== JSON.stringify(overlay)) {
    throw new Error('dist manifest sourceModuleOverlay differs from src/paragraph-vendor/overlay.json');
  }
  for (const mod of EDITOR_MODULES) {
    if (distManifest.editorModuleSha256?.[mod] !== moduleHashes[mod]) {
      throw new Error(`dist manifest editorModuleSha256 mismatch for ${mod}`);
    }
  }
  return distManifest;
}

/** Locate the sibling falsify-pdf-editor git checkout when present. */
export function resolveEditorRepoDir(appDir, explicitDir = null) {
  const candidates = [
    explicitDir,
    process.env.FALSIFY_PDF_EDITOR_REPO,
    resolve(appDir, '../../falsify-pdf-editor'),
    resolve(appDir, '../../../../falsify-pdf-editor'),
    resolve(appDir, '../../../../../falsify-pdf-editor'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git')) || existsSync(join(candidate, 'HEAD'))) {
      return resolve(candidate);
    }
  }
  return null;
}

function verifyModulesAgainstGit({ sourceDir, editorRepoDir, baseCommit, patchPath, patchBytes, moduleHashes }) {
  const hasCommit = runCommand('git', ['-C', editorRepoDir, 'cat-file', '-e', `${baseCommit}^{commit}`], editorRepoDir);
  if (hasCommit.status !== 0) {
    throw new Error(`Commit ${baseCommit} not found in editor repository ${editorRepoDir}`);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'verify-pv-modules-'));
  try {
    mkdirSync(join(workDir, 'src'), { recursive: true });
    const rawMatches = {};
    for (const mod of EDITOR_MODULES) {
      const show = spawnSync('git', ['-C', editorRepoDir, 'show', `${baseCommit}:src/${mod}`], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      if (show.status !== 0) throw new Error(`Missing upstream blob ${baseCommit}:src/${mod}`);
      rawMatches[mod] = sha256Hex(show.stdout) === moduleHashes[mod];
      writeFileSync(join(workDir, 'src', mod), show.stdout);
    }
    if (patchBytes.toString('utf8').trim().length > 0) {
      const apply = runCommand('git', ['-c', 'core.autocrlf=false', '-C', workDir, 'apply', '--whitespace=nowarn', patchPath], workDir);
      if (apply.status !== 0) throw new Error(`Failed to apply overlay patch ${patchPath}: ${apply.stderr}`);
    }
    const results = {};
    for (const mod of EDITOR_MODULES) {
      const reconstructedSha = sha256Hex(readFileSync(join(workDir, 'src', mod)));
      if (reconstructedSha !== moduleHashes[mod]) {
        throw new Error(`Module ${mod} differs from ${baseCommit} + overlay patch (expected ${reconstructedSha}, got ${moduleHashes[mod]})`);
      }
      results[mod] = { sha256: moduleHashes[mod], matchesBaseBlob: rawMatches[mod], matchesBasePlusOverlay: true };
    }
    return results;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Verify overlay metadata, dist manifest consistency, and module reconstruction from git. */
export function verifyEditorModules({ sourceDir, distVendorDir = null, editorRepoDir = null, requireEditorRepo = false } = {}) {
  const { overlay, patchBytes } = verifyOverlayMetadata(sourceDir);
  const moduleHashes = Object.fromEntries(EDITOR_MODULES.map((mod) => [mod, sha256Hex(readFileSync(join(sourceDir, mod)))]));
  if (distVendorDir && existsSync(distVendorDir)) {
    verifyDistVendorManifest(distVendorDir, sourceDir, overlay, moduleHashes);
  }
  if (!editorRepoDir) {
    if (requireEditorRepo) throw new Error('falsify-pdf-editor repository not found for git blob verification');
    return { sourceModuleBase: overlay.base, overlayCommit: overlay.commit, modulesGitVerified: false, reason: 'editor-repo-not-supplied', moduleHashes };
  }
  const patchPath = overlay.patch ? join(sourceDir, overlay.patch) : null;
  const modules = verifyModulesAgainstGit({ sourceDir, editorRepoDir, baseCommit: overlay.base, patchPath, patchBytes, moduleHashes });
  return { sourceModuleBase: overlay.base, overlayCommit: overlay.commit, modulesGitVerified: true, editorRepoDir, modules };
}

function checkCleanTreeCommit(repoDir, expectedCommit) {
  if (!repoDir || !existsSync(repoDir)) return false;
  const head = runCommand('git', ['-C', repoDir, 'rev-parse', 'HEAD'], repoDir);
  if (head.status !== 0 || head.stdout.trim() !== expectedCommit) return false;
  const dirty = runCommand('git', ['-C', repoDir, 'status', '--porcelain'], repoDir);
  return dirty.status === 0 && dirty.stdout.trim() === '';
}

function checkEmccVersion(emccCommand, expectedVersion = '3.1.70') {
  const [cmd, ...extra] = Array.isArray(emccCommand) ? emccCommand : [emccCommand];
  const useShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd);
  const probe = spawnSync(cmd, [...extra, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: useShell,
  });
  if (probe.error || probe.status !== 0) return { available: false, version: null };
  const text = `${probe.stdout}\n${probe.stderr}`;
  return { available: text.includes(expectedVersion), version: text.split(/\r?\n/)[0]?.trim() || null };
}

function runCleanWasmBuild({ sourceDir, manifest, upstreamEngineDir, upstreamPdfiumDir, buildCommand }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'verify-wasm-build-'));
  try {
    const engineCopy = join(sandbox, 'engine');
    const pdfiumCopy = join(sandbox, 'pdfium');
    cpSync(upstreamEngineDir, engineCopy, { recursive: true });
    cpSync(upstreamPdfiumDir, pdfiumCopy, { recursive: true });
    for (const patch of manifest.sourcePatches) {
      const targetDir = patch.name.startsWith('pdfium-') ? pdfiumCopy : engineCopy;
      const apply = runCommand('git', ['-c', 'core.autocrlf=false', '-C', targetDir, 'apply', '--whitespace=nowarn', join(sourceDir, 'patches', patch.name)], targetDir);
      if (apply.status !== 0) return { sourceBuildVerified: false, reason: `patch-apply-failed:${patch.name}` };
    }
    const build = runCommand(buildCommand[0], buildCommand.slice(1), sandbox);
    if (build.status !== 0) return { sourceBuildVerified: false, reason: 'wasm-build-failed' };
    const builtJs = join(sandbox, 'out/editcore.js');
    const builtWasm = join(sandbox, 'out/editcore.wasm');
    if (!existsSync(builtJs) || !existsSync(builtWasm)) return { sourceBuildVerified: false, reason: 'wasm-build-outputs-missing' };
    const jsOk = sha256Hex(readFileSync(builtJs)) === manifest.artifacts.js.sha256;
    const wasmOk = sha256Hex(readFileSync(builtWasm)) === manifest.artifacts.wasm.sha256;
    return jsOk && wasmOk
      ? { sourceBuildVerified: true, reason: 'verified-clean-room-reproducible-build' }
      : { sourceBuildVerified: false, reason: 'rebuilt-artifact-digest-mismatch', jsOk, wasmOk };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Check emsdk 3.1.70 and clean upstream trees; never report sourceBuildVerified=true without a byte-exact rebuild. */
export function verifyWasmSourceBuild({
  sourceDir,
  manifest,
  verifyWasmBuild = false,
  emccCommand = 'emcc',
  upstreamEngineDir = process.env.FALSIFY_UPSTREAM_ENGINE_DIR || null,
  upstreamPdfiumDir = process.env.FALSIFY_UPSTREAM_PDFIUM_DIR || null,
  buildCommand = null,
} = {}) {
  const emcc = checkEmccVersion(emccCommand, manifest.toolchain.emsdk);
  const engineOk = checkCleanTreeCommit(upstreamEngineDir, manifest.upstream.engineCommit);
  const pdfiumOk = checkCleanTreeCommit(upstreamPdfiumDir, manifest.upstream.pdfiumCommit);
  const cleanTreesSupplied = engineOk && pdfiumOk;

  if (!verifyWasmBuild || !emcc.available || !cleanTreesSupplied || !Array.isArray(buildCommand)) {
    return {
      sourceBuildVerified: false,
      reason: REASON_EMSDK_NOT_SUPPLIED,
      emsdkRequired: manifest.toolchain.emsdk,
      emsdkAvailable: emcc.available,
      emsdkVersion: emcc.version,
      cleanTreesSupplied,
    };
  }
  return runCleanWasmBuild({ sourceDir, manifest, upstreamEngineDir, upstreamPdfiumDir, buildCommand });
}

/** Run full provenance verification for app/src/paragraph-vendor and app/dist/paragraph-vendor. */
export function verifyParagraphVendorProvenance(options = {}) {
  const defaultApp = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const appDir = resolve(options.appDir || defaultApp);
  const sourceDir = join(appDir, 'src/paragraph-vendor');
  const distVendorDir = options.checkDist === false ? null : join(appDir, 'dist/paragraph-vendor');
  const editorRepoDir = resolveEditorRepoDir(appDir, options.editorRepoDir || null);

  const candidate = verifyCandidateArtifacts(sourceDir, distVendorDir);
  const modules = verifyEditorModules({
    sourceDir,
    distVendorDir,
    editorRepoDir,
    requireEditorRepo: Boolean(options.requireEditorRepo),
  });
  const wasmBuild = verifyWasmSourceBuild({
    sourceDir,
    manifest: candidate.manifest,
    verifyWasmBuild: Boolean(options.verifyWasmBuild),
    emccCommand: options.emccCommand || 'emcc',
    upstreamEngineDir: options.upstreamEngineDir,
    upstreamPdfiumDir: options.upstreamPdfiumDir,
    buildCommand: options.buildCommand,
  });

  return {
    ok: true,
    schema: 'falsify.paragraph-vendor.provenance-check.v1',
    appDir,
    artifacts: candidate.artifacts,
    patchCount: candidate.patches.length,
    modules,
    ...wasmBuild,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify-wasm-build') opts.verifyWasmBuild = true;
    else if (arg === '--require-editor-repo') opts.requireEditorRepo = true;
    else if (arg === '--app-dir') opts.appDir = argv[++i];
    else if (arg === '--editor-repo') opts.editorRepoDir = argv[++i];
    else if (arg === '--upstream-engine') opts.upstreamEngineDir = argv[++i];
    else if (arg === '--upstream-pdfium') opts.upstreamPdfiumDir = argv[++i];
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = verifyParagraphVendorProvenance(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
