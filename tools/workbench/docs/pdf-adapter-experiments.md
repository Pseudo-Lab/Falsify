# PDF adapter experiments

These are **optional advisory analysis modules**, not a replacement editor or public table/figure attack feature.
Workbench 0.2.0-alpha.1 connects their bounded inventory/object counts and selected-text metrics to RED's explicit
`PDF 사전분석` action through authenticated `POST /api/paper/inspect`. Detailed geometry stays private in the isolated child;
the UI receives fixed counts/statuses only. Docling conversion remains unconfigured. The legacy object-writing prototype stays
unwired; the separate [manual raster-placement writer](pdf-image-editing.md) has its own source-bound HTTP/UI contract.
The default Bento/PDFium editor, HTTP export contract, browser import, independent quality gate and separate RED/BLUE/review
workflows are unchanged. None of these probes may select an edit, widen a QA mask, block a production download or feed a
private source/RED plan into BLUE. These advisory probes add no new required dependency; the separate image writer has optional
pikepdf/Pillow dependencies.

| Component | Implemented and exercised | Not proved |
| --- | --- | --- |
| [Structure adapter](pdf-structure-adapter.md) | DoclingDocument normalization using real docling-core 2.101.1 serializer/model validation, source hash binding, page geometry, both bbox origins, caption refs and reading order | Docling ML conversion, semantic accuracy of predicted regions, cropped/rotated frame mapping, original-layout writeback |
| [Layout probe](pdf-layout-adapter.md) | Exact After metrics in a fixed box/font/size/pitch; explicit fit/overflow/unsupported; glyph checks, obstacles, reconstruction and conservative overlapping-line refusal | Running BabelDOC, CID/ToUnicode encoding, shaping/kerning, font appearance fidelity, writing the proposed layout back into an original PDF |
| [Object probe](pdf-object-adapter.md) | Source-bound raster/vector/shading occurrence inventory; source-wide shared-image checks; synthetic-only unique image-XObject replacement with render proof | Running PDF4QT, shared-image per-occurrence isolation, Form/clipped/masked/vector figure replacement, table replacement |

## Use and authority

The experimental Python modules are `app/local/paper_structure.py`, `pdf_layout_probe.py` and `pdf_object_probe.py`.
Their read-only count/metrics summaries have the advisory HTTP/UI caller described above; the writing prototype does not.
Do not confuse that synthetic-only prototype with the newer isolated manual-image service and its painting-operator writer.
Their detailed outputs are private geometry/metrics hints. The immutable source bytes and
independently derived selected-text plan remain the authority for the existing editor and quality checks.

`normalize_docling(payload, source_bytes)` requires no Docling install. Its `sourceSha256` binds the result to the supplied
source, but does not prove the external payload came from it: even a matching Docling origin hash can be forged. Every result
has `authority: structure-hint`. `convert_isolated` is explicitly opt-in, with an already installed separate interpreter and
local model artifacts. Its successful real ML conversion is **untested**; only schema execution and an actual missing-dependency
child failure were verified. The optional core tests skip in the normal app venv and run in a separate experiment venv.

`propose_layout` is a planner, not an export path. A `fits` result means the measured advances fit, not that any source font
encoding can draw the proposed text. A conservative line-band guard refuses overlapping multi-line metrics, including some
normal-looking tight leading; it reports uncertainty and never changes the requested pitch. Overflow does not trigger shrink,
rewrite or page addition. This does not change the existing editor's explicitly reported continuation-page behavior.

`synthetic_replace_unique_image` is only a fixture prototype. The synthetic metadata keyword is a convention, **not a security
boundary**. The caller must not expose it as an arbitrary user operation. It rewrites a once-used image's object dictionary and
samples, not its painting stream; shared xrefs are refused rather than modifying every placement. It cannot fake a complete
scientific figure or create a table. Input PNG headers and all proof-page geometry are bounded before decode/raster. Native
PyMuPDF list materialization and parsing still have no OS memory/time cap; these modules are not a hostile-upload sandbox.

## Evidence and regressions

Focused tests are `test_paper_structure.py`, `test_pdf_layout_probe.py` and `test_pdf_object_probe.py`; the existing foundation
corpus and acceptance gate remain unchanged. All committed fixtures are generated synthetic documents. Real papers, harnesses,
experiment records, model artifacts and local binaries are not part of this source-only repository.

The coordinator additionally generated a two-page synthetic image replacement and inspected the rendered pages. MuPDF and
the existing pinned PDFium runtime each found zero changed pixels outside the selected placement and a pixel-identical
shared-image control page. This is cross-renderer evidence for that **simple synthetic case**, not universal PDF fidelity,
scientific gold, human approval or RED/BLUE performance evidence. The layout was also rendered for a safe two-line fixed-size
synthetic example; that is not original-PDF reflow proof.

## Next dependent implementation

1. Extend the separate source-derived **painting-operator writer** beyond its initial direct opaque raster boundary only after
   explicit Form-path cloning, clip/mask handling and cross-renderer proof. Its current page-resource isolation must not be
   confused with shared Form-resource isolation. The default text editor is not replaced.
2. Broaden real-paper regression coverage before forms, complex clips, masks, repeated transparent placements and vector figures;
   require inside-region quality and outside-region preservation with at least two renderers. Keep benign/no-op controls.
3. Run real on-demand Docling conversion only in an explicit model/artifact environment. Compare geometry against source
   inventory before using it for user-facing candidate hints; never promote predictions into automatic edit authority.
4. Prove CID/ToUnicode and original-font writeback before using this metrics planner for hard real-paper replacements. Prefer
   the existing proven editor for supported text; no whole-paper reconstruction or silent fallback.
5. Before evaluating table/figure attacks, separately approve their scientific scope and add a visual/structured input
   contract for BLUE. Current BLUE is text-only; not seeing image content is not successful reasoning evasion.

For upstream pins, licenses and runtime/source-only distinctions see each linked adapter document. Docling's MIT code license
does not cover every model automatically; PDF4QT's MIT core does not make Qt dependencies MIT. BabelDOC was inspected for
typesetting ideas, not imported or executed. See [source releases](releases.md) for installed/hosted update boundaries.
