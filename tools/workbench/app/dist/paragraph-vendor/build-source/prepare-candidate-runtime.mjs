// Stages a locally rebuilt editcore JS/WASM pair as an opt-in candidate
// runtime: copies both files and writes candidate-manifest.json into the
// fixed folder <parent>/.runtime-candidate. Nothing is built or downloaded.
//
// The manifest records the caller's artifact digests, the pinned upstream
// commits, the emsdk version and the sha256 of each supplied source patch.
// It is provenance, not proof: this script does not check that the
// artifacts were produced from those sources (see docs/CANDIDATE_RUNTIME.md).
//
// Output safety: the only writable target is the dedicated .runtime-candidate
// folder directly inside an existing, real parent directory. Staging uses
// mkdtemp; an existing folder is only replaced when it holds nothing but the
// three generated files, is moved aside first and restored on failure, and
// is cleaned file-by-file (no recursive removal).
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATE_MANIFEST_NAME, CANDIDATE_PINS, CANDIDATE_SCHEMA, PINS, RuntimeError, checkPinnedCheckout, readCandidateRuntime, resolveSourceRoot, sha256, validateCandidateManifest, verifyAppSource } from "../src/runtime.mjs";

export const CANDIDATE_DIR_NAME = ".runtime-candidate";
const GENERATED = Object.freeze([CANDIDATE_PINS.js, CANDIDATE_PINS.wasm, CANDIDATE_MANIFEST_NAME]);
const HEX64 = /^[0-9a-f]{64}$/;

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const unsafe = (msg) => {
  throw new RuntimeError("UNSAFE_OUTPUT", msg);
};

function validateParent(parentDir) {
  if (typeof parentDir !== "string" || !isAbsolute(parentDir)) unsafe("Candidate parent directory must be an absolute path");
  const abs = resolve(parentDir);
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) unsafe("Candidate parent directory does not exist");
  if (st.isSymbolicLink() || !st.isDirectory()) unsafe("Candidate parent must be a real directory");
  if (!same(realpathSync.native(abs), abs)) unsafe("Candidate parent must not be reached through a link");
  if (same(parse(abs).root, abs) || same(abs, resolve(homedir()))) unsafe("Candidate parent must not be a filesystem root or home directory");
  return abs;
}

// Existing .runtime-candidate must be a real directory holding only generated files.
function inspectExisting(target) {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) unsafe(`${CANDIDATE_DIR_NAME} exists and is not a plain directory; refusing to replace it`);
  const entries = readdirSync(target, { withFileTypes: true });
  for (const e of entries) {
    if (!GENERATED.includes(e.name) || !e.isFile()) unsafe(`${CANDIDATE_DIR_NAME} contains unexpected entry ${e.name}; refusing to replace it`);
  }
  return entries.map((e) => e.name);
}

function removeGeneratedDir(dir) {
  for (const name of readdirSync(dir)) {
    if (!GENERATED.includes(name)) unsafe(`Refusing to remove unexpected file ${name}`);
    unlinkSync(join(dir, name));
  }
  rmdirSync(dir);
}

function readInput(path, what, target) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new RuntimeError("CANDIDATE_INVALID", `${what} must be an absolute path`);
  const abs = resolve(path);
  const rel = relative(target, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new RuntimeError("CANDIDATE_INVALID", `${what} must not be inside ${CANDIDATE_DIR_NAME}`);
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) throw new RuntimeError("CANDIDATE_MISSING", `${what} is missing`);
  if (st.isSymbolicLink() || !st.isFile()) throw new RuntimeError("CANDIDATE_INVALID", `${what} must be a regular file`);
  return readFileSync(abs);
}

/**
 * prepareCandidateRuntime({ parentDir, jsPath, wasmPath, patchPaths,
 *   expectJsSha256?, expectWasmSha256?, note?, sourceRoot?, pins? })
 * => { outDir, manifestPath, manifest }
 */
export function prepareCandidateRuntime({ parentDir, jsPath, wasmPath, patchPaths, expectJsSha256, expectWasmSha256, note, sourceRoot, pins = PINS } = {}) {
  const parent = validateParent(parentDir);
  const target = join(parent, CANDIDATE_DIR_NAME);
  inspectExisting(target);

  if (!Array.isArray(patchPaths) || patchPaths.length === 0) throw new RuntimeError("CANDIDATE_INVALID", "At least one source patch is required as provenance");
  for (const [name, v] of [["expectJsSha256", expectJsSha256], ["expectWasmSha256", expectWasmSha256]]) {
    if (v !== undefined && (typeof v !== "string" || !HEX64.test(v))) throw new RuntimeError("CANDIDATE_INVALID", `${name} must be a lowercase 64-hex sha256`);
  }
  if (note !== undefined && typeof note !== "string") throw new RuntimeError("CANDIDATE_INVALID", "note must be a string");
  const js = readInput(jsPath, "Candidate JS", target);
  const wasm = readInput(wasmPath, "Candidate WASM", target);
  const digests = { js: sha256(js), wasm: sha256(wasm) };
  if (expectJsSha256 && digests.js !== expectJsSha256) throw new RuntimeError("CANDIDATE_HASH_MISMATCH", `Candidate JS sha256 ${digests.js} does not match expected ${expectJsSha256}`);
  if (expectWasmSha256 && digests.wasm !== expectWasmSha256) throw new RuntimeError("CANDIDATE_HASH_MISMATCH", `Candidate WASM sha256 ${digests.wasm} does not match expected ${expectWasmSha256}`);
  const sourcePatches = patchPaths.map((p, i) => ({ name: basename(String(p)), sha256: sha256(readInput(p, `Source patch ${i + 1}`, target)) }));

  // The candidate still runs against the pinned app sources and claims the
  // pinned engine commit; both checkouts must match before anything is written.
  const src = resolveSourceRoot(sourceRoot);
  verifyAppSource(src, pins);
  checkPinnedCheckout(src, pins.engine);

  const provenance = {
    preparedBy: "scripts/prepare-candidate-runtime.mjs",
    preparedAt: new Date().toISOString(),
    jsInputName: basename(jsPath),
    wasmInputName: basename(wasmPath),
    verification: "Artifact and patch sha256 recorded from supplied files only; C++/WASM rebuild from the listed sources was not verified by this script.",
  };
  if (note) provenance.note = note;
  const manifest = {
    schema: CANDIDATE_SCHEMA,
    upstream: { bentopdfCommit: pins.bentopdf.commit, engineCommit: pins.engine.commit, pdfiumCommit: CANDIDATE_PINS.pdfiumCommit },
    toolchain: { emsdk: CANDIDATE_PINS.emsdk },
    sourcePatches,
    artifacts: {
      js: { path: CANDIDATE_PINS.js, sha256: digests.js },
      wasm: { path: CANDIDATE_PINS.wasm, sha256: digests.wasm },
    },
    provenance,
  };
  validateCandidateManifest(manifest, pins);
  inspectExisting(target);

  const staging = mkdtempSync(join(parent, CANDIDATE_DIR_NAME + "-staging-"));
  let backupDir = null;
  let backup = null;
  try {
    writeFileSync(join(staging, CANDIDATE_PINS.js), js, { flag: "wx" });
    writeFileSync(join(staging, CANDIDATE_PINS.wasm), wasm, { flag: "wx" });
    writeFileSync(join(staging, CANDIDATE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    readCandidateRuntime(join(staging, CANDIDATE_MANIFEST_NAME), pins);
    if (inspectExisting(target)) {
      backupDir = mkdtempSync(join(parent, CANDIDATE_DIR_NAME + "-backup-"));
      backup = join(backupDir, "previous");
      renameSync(target, backup);
    }
    try {
      renameSync(staging, target);
    } catch (err) {
      if (backup) renameSync(backup, target);
      throw err;
    }
  } catch (err) {
    try {
      if (lstatSync(staging, { throwIfNoEntry: false })) removeGeneratedDir(staging);
    } catch {}
    if (backupDir) {
      try {
        rmdirSync(backupDir); // non-recursive: only succeeds when empty
      } catch {}
    }
    throw err;
  }
  if (backup) {
    removeGeneratedDir(backup);
    rmdirSync(backupDir);
  }
  return { outDir: target, manifestPath: join(target, CANDIDATE_MANIFEST_NAME), manifest };
}

export function parseArgs(argv) {
  const opts = { patchPaths: [] };
  const names = { "--parent": "parentDir", "--js": "jsPath", "--wasm": "wasmPath", "--expect-js-sha256": "expectJsSha256", "--expect-wasm-sha256": "expectWasmSha256", "--note": "note", "--source-root": "sourceRoot" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new RuntimeError("CANDIDATE_INVALID", `${flag} needs a value`);
    if (flag === "--patch") opts.patchPaths.push(resolve(value));
    else if (names[flag]) {
      if (opts[names[flag]] !== undefined) throw new RuntimeError("CANDIDATE_INVALID", `${flag} given twice`);
      opts[names[flag]] = ["parentDir", "jsPath", "wasmPath", "sourceRoot"].includes(names[flag]) ? resolve(value) : value;
    } else throw new RuntimeError("CANDIDATE_INVALID", `Unknown argument ${flag}`);
    i++;
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifestPath, manifest } = prepareCandidateRuntime(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ ok: true, manifest: manifestPath, js: manifest.artifacts.js.sha256, wasm: manifest.artifacts.wasm.sha256 }));
  } catch (err) {
    console.error(`prepare-candidate-runtime: ${err.code ?? "ERROR"}: ${err.message}`);
    process.exit(1);
  }
}
