# Third-party notices

This file inventories third-party material that Falsify PDF Editor uses, the
exact notice files reproduced in [`licenses/`](licenses/), and where the
corresponding source can be obtained. It is an engineering record, not legal
advice or a compliance certification. Pins and hashes are machine-readable in
[`UPSTREAM.json`](UPSTREAM.json).

Falsify PDF Editor itself is Copyright (C) 2026 Shinick-Han and licensed
AGPL-3.0-only ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)).

## How upstream code reaches the module

| Path in this repository | What it is | How it is obtained |
|---|---|---|
| `upstream/bentopdf/` | BentoPDF application source | Git submodule pinned to `3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97` |
| `upstream/engine/` | BentoPDF PDF Viewer (PDFium/editcore engine) source | Git submodule pinned to `813903c93c758dfb8df46dbd34ace3b7f7a8538b` |
| `.runtime/editcore.wasm`, `.runtime/editcore.js` (ignored, generated) | Upstream compiled engine | Byte copy of engine Git blobs `packages/pdfium/src/vendor/pdfium.wasm` and `pdfium.js`, SHA-256 checked |

Only these two runtime files are generated from upstream. Other upstream
assets present in the submodules (fonts, pdf.js viewer files, web UI) are not
copied or redistributed by this module and keep their own license files in
the upstream trees.

## Components

### BentoPDF

- Source: <https://github.com/alam00000/bentopdf> at
  `3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97` (`git describe`:
  `v2.8.8-40-g3a5f146`; package `bento-pdf` 2.8.8).
- License: AGPL-3.0-only (`package.json`). The upstream `LICENSE` is
  byte-identical to this repository's [`LICENSE`](LICENSE).
- Used: `src/js/editcore/*.js` and the `src/js/utils/freetext-script.ts`
  helper it imports, loaded unmodified from the submodule.
- BentoPDF's authors also offer their own contributions under commercial
  terms. This project has not obtained or evaluated such a license and makes
  no claim about whether it would cover the engine or editcore.

### BentoPDF PDF Viewer engine (bentopdf-pdfium-viewer)

- Source: <https://github.com/alam00000/bentopdf-pdfium-viewer> at
  `813903c93c758dfb8df46dbd34ace3b7f7a8538b`.
- License: AGPL-3.0-only (root `package.json`; root `LICENSE` is
  byte-identical to this repository's `LICENSE`). Copyright 2026 BentoPDF.
- Notice reproduced: [`licenses/bentopdf-pdfium-viewer/NOTICE`](licenses/bentopdf-pdfium-viewer/NOTICE).
- Used: the compiled `pdfium.wasm` / `pdfium.js` described above. The engine's
  editcore C++ sources live in `packages/pdfium/build/code/editcore/`.
- Provenance note: the editcore directory was not present at the EmbedPDF
  fork point and was added after BentoPDF relicensed the repository root to
  AGPL. The `packages/pdfium` subpackage still carries MIT metadata
  (`@embedpdf/pdfium` 2.9.1, `"license": "MIT"`) inherited from EmbedPDF. This
  project does **not** treat that metadata as an MIT grant for editcore and
  uses editcore under AGPL-3.0-only.

### EmbedPDF

- Upstream: <https://github.com/embedpdf/embed-pdf-viewer>, included in the
  engine and modified by BentoPDF.
- License: MIT, Copyright 2025 CloudPDF:
  [`licenses/bentopdf-pdfium-viewer/LICENSE.embedpdf-mit`](licenses/bentopdf-pdfium-viewer/LICENSE.embedpdf-mit).
- Engine `packages/pdfium` MIT license, Copyright (c) 2024 CloudPDF, Ji Chang:
  [`licenses/bentopdf-pdfium-viewer/packages-pdfium-LICENSE.mit`](licenses/bentopdf-pdfium-viewer/packages-pdfium-LICENSE.mit).
- The pinned engine README refers to a `LICENSE-MIT` file; at the pinned commit
  the MIT text is located at `licenses/LICENSE.embedpdf-mit` instead.

### HarfBuzz

- Upstream: <https://github.com/harfbuzz/harfbuzz>, vendored in the engine at
  `packages/pdfium/build/code/harfbuzz` and compiled into the WASM.
- License: "Old MIT":
  [`licenses/bentopdf-pdfium-viewer/LICENSE.harfbuzz`](licenses/bentopdf-pdfium-viewer/LICENSE.harfbuzz).
- The vendored `src/ms-use/COPYING` (MIT, Copyright (c) Microsoft Corporation):
  [`licenses/bentopdf-pdfium-viewer/harfbuzz-src-ms-use-COPYING`](licenses/bentopdf-pdfium-viewer/harfbuzz-src-ms-use-COPYING).

### PDFium

- Upstream fork: <https://github.com/embedpdf/pdfium>, nested submodule
  `packages/pdfium/pdfium-src` of the engine, pinned at
  `fce2b000cc7a9e2cabc92db41cd57ca03233f07d`; build patches in the engine's
  `packages/pdfium/build/patch/`.
- License: Copyright 2014 PDFium Authors, BSD-3-Clause style, with Apache
  License 2.0 text appended, as shipped by the engine:
  [`licenses/bentopdf-pdfium-viewer/packages-pdfium-LICENSE.pdfium`](licenses/bentopdf-pdfium-viewer/packages-pdfium-LICENSE.pdfium).

## Copy method

Every file in `licenses/` and the root `LICENSE` is a mechanical byte copy of a
Git blob at the pinned upstream commit (`git cat-file blob <commit>:<path>`),
so line endings match the repository objects rather than a Windows checkout.
Source paths and SHA-256 values are listed in `UPSTREAM.json`.

## Known gaps

- PDFium statically links libraries from its own `third_party/` tree and
  Chromium build dependencies (for example FreeType, zlib and image codecs).
  Their license files are in the pinned PDFium source and its DEPS, which were
  **not** checked out for this inventory, so they are not reproduced here.
  Anyone redistributing the WASM should collect them from
  `fce2b000cc7a9e2cabc92db41cd57ca03233f07d` and its pinned DEPS.
- BentoPDF's tarball `vendor/bentopdf-pdfium/bentopdf-pdfium-813903c93c75.tgz`
  contains package metadata, JS and WASM only, without LICENSE or NOTICE
  files. This repository supplies the notices above instead of relying on that
  artifact.
- Emscripten runtime code generated into `pdfium.js` and linked Emscripten
  system libraries are covered by Emscripten's own licenses, which are not
  reproduced here.

## Corresponding source

The complete module source and these notices are intended to be published at
<https://github.com/Shinick-Han/falsify-pdf-editor>. Cloning with
`git clone --recurse-submodules` retrieves the pinned BentoPDF and engine
sources. The PDFium source used for the engine is the engine's nested
submodule, retrievable with
`git -C upstream/engine submodule update --init packages/pdfium/pdfium-src`.
See [`docs/BUILD.md`](docs/BUILD.md) for the distinction between the upstream
binary and an independent rebuild.
