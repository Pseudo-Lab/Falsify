# Candidate runtime (opt-in, locally rebuilt engine)

The default runtime is the **pinned baseline**: `.runtime/editcore.js` and
`.runtime/editcore.wasm` must match the SHA-256 values in `PINS`
(`src/runtime.mjs`) exactly. Nothing in this document changes that default.

A *candidate* is a locally rebuilt editcore JS/WASM pair that a caller may
opt in to, for example to evaluate a WASM rebuilt from the pinned C++ with
source patches applied.

## Opting in

A candidate is used only when explicitly selected:

- `loadRuntime({ candidateManifest: "<absolute path>/candidate-manifest.json" })`, or
- environment variable `FALSIFY_EDITOR_CANDIDATE_MANIFEST=<absolute path>/candidate-manifest.json`.

`editPdf` and the CLI do not forward a `candidateManifest` option; they pick
up a candidate only through the environment variable. An unset or empty
variable means baseline; `candidateManifest: null` forces baseline even when
the variable is set. A relative path is rejected. Combining a candidate with
`runtimeDir` is rejected (`CANDIDATE_CONFLICT`).

A manifest is **never** loaded because it exists: a `candidate-manifest.json`
placed in `.runtime/` (or anywhere else) is ignored unless selected as above,
and the baseline keeps rejecting any JS/WASM whose hash is not the pin.

## Preparing a candidate folder

```sh
node scripts/prepare-candidate-runtime.mjs \
  --parent <absolute dir> \
  --js <built pdfium.js> --wasm <built pdfium.wasm> \
  --patch <patch file> [--patch <patch file> ...] \
  [--expect-js-sha256 <hex>] [--expect-wasm-sha256 <hex>] [--note <text>]
```

The script writes exactly three files into the fixed folder
`<parent>/.runtime-candidate/`: `editcore.js`, `editcore.wasm`,
`candidate-manifest.json`. It refuses a parent that is relative, missing, a
link, a filesystem root or the home directory, and it only replaces an
existing `.runtime-candidate` that holds nothing but those three files
(staged with `mkdtemp`, swapped by rename, old copy removed file by file).
Before writing it verifies the pinned BentoPDF app sources
(`verifyAppSource`) and the pinned engine checkout. At least one patch is
required. `.runtime-candidate` and its staging/backup folders are ignored;
prefer a parent outside the repository to separate local artifacts from code.

## Manifest (`falsify-editor-candidate-runtime/1`)

```json
{
  "schema": "falsify-editor-candidate-runtime/1",
  "upstream": {
    "bentopdfCommit": "3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97",
    "engineCommit": "813903c93c758dfb8df46dbd34ace3b7f7a8538b",
    "pdfiumCommit": "fce2b000cc7a9e2cabc92db41cd57ca03233f07d"
  },
  "toolchain": { "emsdk": "3.1.70" },
  "sourcePatches": [{ "name": "editcore.patch", "sha256": "<64 hex>" }],
  "artifacts": {
    "js": { "path": "editcore.js", "sha256": "<64 hex>" },
    "wasm": { "path": "editcore.wasm", "sha256": "<64 hex>" }
  },
  "provenance": { "note": "free-form strings only" }
}
```

Validation (all before any code is imported):

- file is named `candidate-manifest.json`, is a regular file, at most 256 KiB, valid JSON;
- unknown fields are rejected at every level, so the manifest cannot add
  claims such as `"rebuiltFromCpp": true`; `provenance` values must be strings;
- `schema` exact; commits are 40-hex and must equal the module pins
  (`CANDIDATE_PIN_MISMATCH` otherwise); `toolchain.emsdk` must be `3.1.70`;
- `sourcePatches` non-empty, unique names, 64-hex digests;
- artifact paths are exactly `editcore.js` / `editcore.wasm` next to the
  manifest (no other directories), regular files, and their SHA-256 must
  equal the manifest digests (`CANDIDATE_HASH_MISMATCH`).

Only then is the pinned app source verified (`verifyAppSource`, unchanged and
rechecked on every `loadRuntime` call) and the engine imported. The candidate
JS is served to the module loader from the bytes that were hashed (a
`registerHooks` load hook), and the WASM is passed from memory, so neither
file is re-read after verification. The JS module URL carries
`?fpe-candidate=<tag>`, where the tag is a SHA-256 of the manifest path and
manifest bytes; the editcore module graph is tagged the same way. A changed
or relocated candidate therefore gets a fresh module instance and cache
entry, never one imported for a different candidate or for the baseline.

The resolver/load hooks are process-global, so `loadRuntime` serializes only
the temporary hook registration, the engine and editcore graph import, and
hook deregistration through a queue shared by this loader module instance (a failed import releases
it). Concurrent `loadRuntime` calls (for example `Promise.all` over baseline
and candidates) therefore each import their own static editcore graph under
their own tag; manifest checks, cache lookup and every `engineFactory` call
still run in parallel. This covers the static import graph loaded inside
that window only: a module the app imports lazily after the hooks are
deregistered is resolved without them and is not claimed to be isolated.
Loading another copy of this loader under a different module URL creates a
separate queue; unrelated external resolver hooks are not governed by it.

`report.runtime.candidate` (and `loadRuntime().info.candidate`) records the
manifest path and hash, pins, toolchain, patch list, provenance, module tag,
`trust: "caller-expected-digests"` and `sourceBuildVerified: false`.

## Trust boundary

The manifest digests are **the caller's own expectations**, not an
independent or signed release attestation. Anyone who can write the
candidate folder can write a matching manifest. Verification proves only:

- the loaded JS/WASM bytes equal the digests in the selected manifest;
- the manifest names this module's pinned commits and emsdk version;
- the pinned app sources are unmodified.

It does **not** prove that the artifacts were built from those commits,
patches or toolchain, that the build is reproducible, or that the patches
listed were the ones applied. Those claims need an independent rebuild and
comparison, recorded outside this module. The expected candidate hashes for
a real rebuild are supplied by whoever performed it (for example with
`--expect-js-sha256` / `--expect-wasm-sha256`).

The tests use the baseline JS/WASM with a mocked patch list; they establish
path handling, rejection-before-import and cache identity only, not any C++
rebuild.
