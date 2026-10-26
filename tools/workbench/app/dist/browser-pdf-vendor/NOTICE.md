# MuPDF.js 1.28.1

Copyright (C) 2004-2026 Artifex Software, Inc.

MuPDF is free software under the GNU Affero General Public License,
version 3 or later. The terms are in the workbench `LICENSE` file
(AGPL-3.0). Upstream source for this pinned release:

- https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1
- https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1
- npm `mupdf@1.28.1` (https://www.npmjs.com/package/mupdf/v/1.28.1)

`mupdf.js`, `mupdf-wasm.js` and `mupdf-wasm.wasm` are the official
package artifacts named in `manifest.json`, with SHA-256 recorded there.
This repository does not rebuild those binaries. Alternative commercial
terms, if any, are available from Artifex and are not granted here.

Falsify workbench code that calls this engine is AGPL-3.0-only.
The browser editor removes text with MuPDF redaction and writes new text
operators. It does not ship the falsify-pdf-editor patched PDFium candidate.
