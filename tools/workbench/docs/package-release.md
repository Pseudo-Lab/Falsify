# Source packaging and verify-only CI

`scripts/package-release.mjs` builds a source ZIP from one clean commit. It does not push, deploy, or publish. Root owns version bumps and the actual release.

## WASM exceptions

`.wasm`, `.pdf`, `.docx`, `.wav`, and `.mp3` stay out of the archive, with two narrow exceptions:

- PDF.js runtime already shipped under `app/dist/vendor/wasm/`: `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`, `quickjs-eval.wasm`.
- `app/dist/browser-pdf-vendor/mupdf-wasm.wasm` only when `manifest.json` is MuPDF.js `1.28.1`, `AGPL-3.0-or-later`, and records SHA-256 `5a30ef7b027f541ea8fc54e7c73f16414b0b59940741a12efe5e55f1fd0a99d7` (10409826 bytes), the file matches that digest, `NOTICE.md` names that version, the file, and the AGPL, and the workbench `LICENSE` is still the AGPL notice.

No other WASM path is added. A private PDF is still rejected. The receipt keeps `includesPatchedEditorWasm: false` because this file is the official npm MuPDF.js build, not the patched falsify-pdf-editor candidate.

## Workflow

`.github/workflows/pages.yml` runs verify jobs on a push to `main` and on `workflow_dispatch` of any branch. The deploy job runs only when `github.ref == refs/heads/main` and the verify jobs passed. A feature-branch dispatch is verify-only.

`verify-macos-arm` (`macos-15`) and `verify-macos-intel` (`macos-15-intel`) use Node 24 and Python 3.12 and run `scripts/test-posix-connection.sh` plus `scripts/test-macos-handler.sh`. The latter compiles and registers an isolated test scheme with real macOS tools, then unregisters it; it does not click a native approval dialog. Windows keeps PowerShell 7 (`pwsh`) and Windows PowerShell 5.1 (`powershell`).

The browser dependency step runs `npm ci --ignore-scripts` and installs Chromium before all browser contracts. The MuPDF step supplies the installed browser and Python executable paths. `scripts/assert-browser-pdf-executed.mjs` fails the job if the actual browser test was skipped. A skip is not a success.

```bash
node --test scripts/packaging.spec.mjs
```

These checks are packaging evidence, not a release certification.
