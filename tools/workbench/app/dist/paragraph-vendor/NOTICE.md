# Falsify paragraph PDF engine browser adapter

The five base editor modules were copied from
Shinick-Han/falsify-pdf-editor commit cd4ba2cdd68ae7e51198f615bd4ac6130206b162:
editor.mjs, quality.mjs, pagination.mjs, inline-preservation.mjs,
continuation-template.mjs. Their original notices, AGPL-3.0-only LICENSE,
third-party notices, patches and dependency licenses accompany this copy.

The paragraph-flow overlay now modifies editor.mjs, quality.mjs, pagination.mjs
and continuation-template.mjs. overlay.json identifies the exact base, commit,
source branch and complete corresponding patch including tests and documentation.
The generated dist bundle is built from these modules under app/src/paragraph-vendor;
its manifest records current module hashes. See build-source/PAGINATION.md for
bounded layout support and the edited-page ICC colour conversion limitation.

engine/* and utils/freetext-script.ts are copied from BentoPDF commit
3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97 (AGPL-3.0).
Source: https://github.com/alam00000/bentopdf/tree/3a5f146d1b89d54dc7ca576aa6797c8bd3e42b97

The browser bundle aliases only node:crypto to Falsify's existing synchronous
SHA-256, editor runtime.mjs to the fixed browser runtime, engine-loader.js to
a constructor-only guard, and the extensionless freetext-script import.
The actual PdfEngine constructor and paragraph/edit/layout logic are reused.

Runtime JS/WASM are locally supplied artifacts. candidate-manifest.json binds
their exact SHA-256 identities, upstream pins, Emscripten version and four
corresponding patch digests. The build verifies those identities. It does not
verify that these binaries were built from the listed source or patches.
Source reproducibility must not be claimed. See accompanying original
THIRD_PARTY_NOTICES.md, licenses/, patches/ and candidate-manifest.json.

Engine source pin: https://github.com/alam00000/bentopdf-pdfium-viewer/tree/813903c93c758dfb8df46dbd34ace3b7f7a8538b
PDFium source pin: fce2b000cc7a9e2cabc92db41cd57ca03233f07d.
The enclosing source distribution must preserve upstream build instructions,
these pins, all four patches and any additional editor-module overlay diff.
UPSTREAM.json retains the original complete pin/notice inventory. build-source/
contains the original candidate instructions, preparation script and pinned
PDFium build entry point/README for reference (they run from a complete
upstream source checkout, not from this browser-adapter source directory).

Browser PDF bytes stay local. The only fetches are fixed same-origin runtime
assets; the implementation has no CLI, companion or model calls.

Document-flow overlay also adds document-flow.mjs, document-flow-band.mjs,
document-flow-links.mjs and document-flow-underlines.mjs. It reuses the same
hash-pinned native runtime; the optional raw annotation adapter is Workbench
source in app/src/document-flow-annotations.mjs using the existing MuPDF vendor.
See build-source/DOCUMENT_FLOW.md and overlay.json for exact source scope.

Local editor change after the pinned overlay: patches/local-deletion-alignment.patch
records the deletion alignment and source-line glyph reuse changes against the repository source paths.
