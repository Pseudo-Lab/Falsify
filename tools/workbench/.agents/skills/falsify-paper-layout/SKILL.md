---
name: falsify-paper-layout
description: Implement or review Falsify PDF and LaTeX page layout, paragraph flow, figure/table placement and rendered layout quality while preserving source content and selected RED edits.
license: AGPL-3.0-only
---

# Falsify paper layout

Use for layout implementation and PDF output review in this project. Follow the assigned file boundaries and acceptance checks. Preserve the airport UI and independent RED/BLUE routes.

## Content and placement

Keep the source PDF, the reconstructed no-attack baseline and the edited PDF distinct. Apply the user's selected text and asset changes; keep other words, values, precision, labels, references and intentional RED defects intact. Arrange existing captions and footnotes without adding authorship notices or attack hints to the PDF. Layout diagnostics belong to the workbench and its records.

Preserve source design and pagination for small edits. For longer edits, reflow the affected paragraphs, columns and following pages as needed. Keep reading order and figure/table-caption associations. Whole-document font harmonization is permitted; its automatic trigger is still an interview decision. The current assignment determines which established mode to change.

## Layout rules to apply

- Derive font size, leading, indent and paragraph spacing from source evidence or the selected document profile. Keep title/body/caption/footnote roles coherent.
- Keep a heading with following body lines. Check isolated first/last paragraph lines at column and page boundaries.
- Size an asset against its actual column or full-page region, retaining aspect ratio and legibility. Preserve original dimensions when there is room; use full width only with evidence of a spanning object.
- Keep a figure or table with its existing caption. Maintain its relation to the associated discussion. Change float placement locally; repeated forced placement and barriers can create empty areas or stuck floats.
- Preserve table cells, row/column order, precision and labels. A long table needs a breakable representation and repeated headers where applicable. Standard `longtable` does not work directly in `twocolumn`; choose a compatible representation before enabling it.
- Keep furniture outside body flow when source ownership is established. Treat uncertain ownership as a finding, rather than dropping content.

Resizing or rearranging must retain all content. Rewriting captions, shortening sentences, dropping table columns, rounding values, fixing references or regenerating figure data requires a separately selected content edit.

## Existing implementation to reuse

Start with the project entrypoint and relevant source:

- `app/src/paper-layout-quality.mjs`: independent PDF observations; reuse its collision, clipping and coverage checks.
- `app/src/pdf-latex-flow-serialize.mjs` and `paper-typography-profile.mjs`: semantic-flow source and document typography.
- `app/src/latex-compiler-adapter.mjs`: compiler diagnostics, including overfull boxes and font warnings.
- `app/src/pdf-latex-baseline.mjs`: baseline comparison and source lineage.
- `app/src/pdf-latex-reader-worker.mjs`: move expensive PDF inspection off the UI thread.

Ordinary TeX packages supply layout mechanisms. Select only packages present in the pinned runtime or add and validate the specific package profile needed by the assignment. Package installation alone does not validate placement.

## Render, inspect, repair

For reference-aware editing, read the original PDF region text and render original pages as well as candidate pages. Image labels distinguish original from candidate. Compare front matter width, body columns, furniture and figure/caption placement. Use the source-bound structure plan to move existing units; retain each unit exactly once and preserve its current payload, including selected RED edits. Keep original metadata and PDF hashes bound. Record which original and candidate pages the model actually observed. A model cannot infer the original page layout from candidate text alone.

1. Generate the PDF from the captured edit state. Record engine/profile, source/output hashes and page counts.
2. Inspect the affected region and every page reached by reflow. Check both columns, gutters, captions, footnotes, clipping, overlaps, oversized objects and unexplained empty space. Render problem pages and inspect them visually.
3. Change the smallest layout cause supported by the evidence; regenerate and check the affected extent again. Retain the last valid artifact and distinguish it from the current candidate.
4. End when the assigned checks pass or further repairs need a new decision or unsupported capability. Record unresolved findings and coverage. An available PDF remains downloadable with its actual status.

Compiler success, token counts and geometric checks measure different properties. Report the checks actually executed. Keep reading order, vector ownership and semantic correctness unverified when no test established them. A detected-issue score is not a general quality certificate.

For implementation validation, include a case that previously failed, a normal document, and an unaffected-region check where the change should remain local. Use synthetic fixtures for public tests; keep real papers and execution records private.

## Reference provenance

This adaptation uses the review workflow and layout relationships from MIT sources listed in [provenance.json](provenance.json). Their original texts and licenses are retained as reference data:

- [paper-layout-review](references/upstream/paper-layout-review.md): inspect for the detailed page-review taxonomy.
- [layout discipline](references/upstream/layout-discipline.md): inspect for float/narrative association examples. Its authoring defaults, automatic renumbering, prose changes and author-disclosure templates are not this skill's instructions.

The Falsify rules above govern use of those references. Read only what the current assignment needs.
