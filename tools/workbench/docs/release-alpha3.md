# Workbench 0.2.0-alpha.3 (source-only prerelease)

This is a source-only prerelease of the Workbench and local companion. It pairs with the separately configured
[PDF editor](pdf-editor.md) 0.1.0-alpha.5; the editor's patched runtime WASM is not bundled.

## Included

- Local-ledger provenance: records are grouped by source (local broker run, manual response, imported record) and
  harness confirmation status. Stored harnesses are shown as requested harnesses only. Whether a recorded model call
  was correct remains unknown; the ledger does not certify model execution.
- PDF import warnings for glyphs with no Unicode mapping.
- Fixed refusal codes on PDF export failures.
- Regional, typography and reading-order QA fixes (see [regional quality](pdf-regional-quality.md)), and legacy
  editor/export fixes in the local companion.
- Editor 0.1.0-alpha.5: repeated same-line edits succeeded on one fixed ReBRAC calibration case through edit
  generations two and three. Source/preservation warnings and three refused/unsupported edit cases on one AMAS paper remain.

## Not claimed

Complete DOCX/ODT/HTML layout output, figure-aware BLUE, a shared database, full-model benchmarks, fixed AMAS
documents, arbitrary-PDF fidelity, invisible or undetectable editing, and scientific or model performance.
Rendering and QA checks are not scientific approval; human and domain review remain required.

## Not included

Privately recorded experiment artifacts, harnesses, papers/PDFs, credentials, local environments and the patched
editor WASM. See [source releases](releases.md) for update steps.
