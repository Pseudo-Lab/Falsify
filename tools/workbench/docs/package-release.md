# Source packaging and verify-only CI

`scripts/package-release.mjs` builds a source ZIP from one clean commit. It does not push, deploy, or publish. Root owns version bumps and the actual release.

## WASM exceptions

`.wasm`, `.pdf`, `.docx`, `.wav`, and `.mp3` stay out of the archive, with named exceptions:

- PDF.js runtime already shipped under `app/dist/vendor/wasm/`: `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`, `quickjs-eval.wasm`.
- `app/dist/browser-pdf-vendor/mupdf-wasm.wasm` only when `manifest.json` is MuPDF.js `1.28.1`, `AGPL-3.0-or-later`, and records SHA-256 `5a30ef7b027f541ea8fc54e7c73f16414b0b59940741a12efe5e55f1fd0a99d7` (10409826 bytes), the file matches that digest, `NOTICE.md` names that version, the file, and the AGPL, and the workbench `LICENSE` is still the AGPL notice.

- The source and distributed paragraph editor WASM at `app/src/paragraph-vendor/runtime/editcore.wasm` and `app/dist/paragraph-vendor/editcore.wasm`, together, with pinned runtime hashes and notices.
- Typst recomposition `app/dist/recomposition-vendor/typst_ts_web_compiler_bg.wasm` and BusyTeX `app/dist/latex-compiler-vendor/busytex.wasm`, verified against their pinned profiles.

Other WASM paths and private PDFs are rejected; three hash-pinned synthetic PDF fixtures are allowed. The receipt's `includesPatchedEditorWasm` is true when the tracked distributed paragraph WASM is present; `paragraphRuntime.sourceBuildVerified` remains false. The official MuPDF.js build is a separate exception.

## Workflow

`.github/workflows/pages.yml` runs verify jobs on a push to `main` and on `workflow_dispatch` of any branch. The deploy job runs only when `github.ref == refs/heads/main` and the verify jobs passed. A feature-branch dispatch is verify-only. The verify job uploads its tested `app/dist` as `verified-app-dist`; deploy downloads that artifact and creates the separate Pages artifact. A clean detached worktree at the workflow commit produces the source ZIP for mandatory packaged harness acceptance.

`verify-macos-arm` (`macos-26`) and `verify-macos-intel` (`macos-15-intel`) use Node 24 and Python 3.12 and run `scripts/test-posix-connection.sh` plus `scripts/test-macos-handler.sh`. The latter compiles and registers an isolated test scheme with real macOS tools, then unregisters it; it does not click a native approval dialog. Windows keeps PowerShell 7 (`pwsh`) and Windows PowerShell 5.1 (`powershell`).

The browser dependency step runs `npm ci --ignore-scripts` and installs Chromium before all browser contracts. The MuPDF step supplies the installed browser and Python executable paths. `scripts/assert-browser-pdf-executed.mjs` fails the job if the actual browser test was skipped. A skip is not a success.

```bash
node --test scripts/packaging.spec.mjs
```

These checks are packaging evidence, not a release certification.

## LaTeX runtime

The pinned BusyTeX WASM and texlive-basic data are included only with the exact seven-file compiler manifest in `app/latex-compiler-manifest.json`; `verifyLatexRuntime` verifies sizes and SHA-256 hashes. Source tests include only hash-pinned synthetic PDF fixtures. Asset cache build hashes may accompany the release version in entry URLs.
