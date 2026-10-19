# Changelog

## 0.2.0-alpha.3

Source-only prerelease. See docs/release-alpha3.md. The separately configured PDF editor is 0.1.0-alpha.5.

- Experiment records separate local-broker runs, manual responses and imported records; a harness-hash mismatch or
  missing hash is shown as an unconfirmed harness and excluded from averages. Model-call correctness stays unknown.
- PDF import warns about glyphs without a Unicode mapping instead of silently using their text.
- PDF export refusals carry fixed refusal codes; regional, typography and reading-order QA gained a bounded
  rigid-run tolerance (0.02 pt, warning only) and a block-order proof for reordered-but-complete text.
- Legacy editor/export fixes in the local companion, with focused regressions.

Not claimed: complete DOCX/ODT/HTML layout output, figure-aware BLUE, a shared database, full-model benchmarks or
AMAS documents being fixed. No arbitrary-PDF, invisibility or scientific performance claims.

## 0.2.0-alpha.2

- Optional manual raster-image placement selection in RED, separate from text candidates and BLUE.
- Source-bound painting IDs and single-occurrence resource isolation, including shared page resources.
- PNG Before/After and experimental-copy consent; PDF and separate rendering-check report downloads.
- Authenticated isolated image service with bounded input, fixed errors and temporary cleanup.

Requires optional image dependencies on Python3.11+. Forms/inline images, complex clipping/masks, vector figures and tables
are outside the initial supported boundary. BLUE remains text-only, and rendering checks are not scientific approval.
See docs/pdf-image-editing.md. Six synthetic shared/inherited placements were each replaced separately: MuPDF and the
configured PDFium runtime found zero changed pixels outside the selected region. This is not arbitrary-paper fidelity or
domain approval. The separate PDF editor remains0.1.0-alpha.4; image writing is an optional companion operation.

## 0.2.0-alpha.1

Source-only prerelease of the Workbench and local companion. The separate PDF editor remains 0.1.0-alpha.4.

- Source-derived text edit plans and independent edited-page/region quality checks.
- Exact downloaded-PDF preview using the verified output bytes, with cancellation and bounded page rendering.
- Optional structure, fixed-area layout and object-occurrence analysis modules, with synthetic regression coverage.
- Explicit authenticated PDF preflight from RED: source inventory, shared-image counts and advisory selected-text layout.
  Does not run a model, authorize a scientific attack, block text export or pass RED information into BLUE.
- Companion version and feature reporting, while retaining old-companion/manual operation compatibility.

Docling ML conversion is not enabled; structure schema compatibility was tested separately. The layout planner is metrics-only,
not a new PDF writer. Object replacement is still a synthetic-only unique-XObject prototype at this release boundary; shared
per-occurrence writing is the next implementation. BLUE remains text-only.

The source archive excludes local environments, private papers/harnesses/records, model artifacts and the locally patched WASM.
Longer PDF export requires the separately configured editor described in docs/pdf-editor.md. Existing user installations must
restart idle companions through the supported launcher; pairing tokens change on restart and browser-local records are retained.
