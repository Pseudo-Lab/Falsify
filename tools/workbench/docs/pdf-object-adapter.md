# PDF object occurrence probe (experimental)

`app/local/pdf_object_probe.py` is a private, bounded, **read-only** inventory of object occurrences in the immutable
source PDF, read with the already installed PyMuPDF 1.28.2 (MuPDF 1.28.2). It is the planning baseline for a future
figure/object adapter. It is **not** an object editor, it is not wired into export, editor service, bridge, HTTP or UI,
and no capability value in it is an editability guarantee. There is no public operation that replaces or fakes a figure.

## Private probe (`falsify.pdf-object-probe.v1`)

```
{schema, sourceSha256, policy: 'inventory-only', status: available|unavailable, complete, pageCount,
 operations: {replaceImageOccurrence: 'unsupported', replaceSharedImageOccurrence: 'unsupported',
              replaceUniqueImageXObject: 'synthetic-prototype-only'},
 pages: [{pageIndex, rotation, supportedGeometry, occurrences, truncated}],
 occurrences: [{id, pageIndex, kind: image|inline-image|vector|shading, ordinal, xref, resourceNames, bbox, transform,
                sharedUse: {placements, pageCount, objectReferences, complete} | null, capability, reasons}],
 resources: [{xref, placements, pageCount, pages, objectReferences, complete}]}
```

- `id` is `occ-` + 24 hex of SHA-256 over (sourceSha256, pageIndex, kind, per-kind ordinal, xref, bbox, transform):
  deterministic and bound to the exact source bytes. `bbox`/`transform` are MuPDF page-space values of the
  unrotated page (top-left origin).
- MuPDF read APIs used: `Page.get_image_info(xrefs=True)` (one entry per rendered placement, forms expanded, `xref` 0
  for inline images), `Page.get_images(full=True)` (resource names, soft mask, referencing form xref),
  `Page.get_drawings(extended=True)` (vector paths and clip scissors), `Page.get_bboxlog()` (shadings),
  `Document.xref_object` (indirect-reference count).
- `sharedUse` is **source-wide**: rendered placements of that xref over every page (not just probed pages) and the
  number of `N G R` references to it from every object. When `maxCountPages` (512), `maxPagePlacements` (2000 image
  placements on one page), `maxPlacements` (20000 placements in total) or `maxObjects` (200000) stops the count,
  `complete` is false and every image occurrence gets `shared-use-incomplete`, so none stays `inspected`. Probed pages
  are capped at 64, image placements and resource listings at 2000 per page, drawings at 5000 per page, occurrences at
  500 per page and 4000 overall; any cap sets `truncated`/`complete: false`, and an image on a page whose placements,
  listing or drawings were cut gets `page-truncated` (its clips/repeats are not fully known).
- Bounds are Python-side counts and loop budgets plus the 25 MiB input cap. PyMuPDF still materializes each page's
  native list (`get_image_info`, `get_images`, `get_drawings`, `get_bboxlog`) before its length can be checked, and no
  OS-level memory/time limit (job object, rlimit, subprocess) is applied. A hostile page can therefore still cost one
  page's native parse before it is refused or truncated.

### Capability

| capability | meaning |
| --- | --- |
| `inspected` | page-level image XObject whose xref has exactly one placement and one object reference in the whole source, identity page geometry, axis-aligned transform, single resource name, no soft mask, no form, no non-containing/non-rectangular clip, no repeated bbox. Still not "editable". |
| `ambiguous` | an image XObject with any reason below |
| `unsupported` | `inline-image` (no xref), `vector-no-object-identity`, `shading-no-object-identity` |

Image reasons: `shared-xref`, `shared-use-incomplete`, `via-form`, `multiple-resource-names`, `resource-unresolved`,
`soft-mask`, `transform-not-axis-aligned`, `clip-uncertain`, `repeated-bbox`, `page-geometry`, `degenerate-bbox`,
`page-truncated`.
`clip-uncertain` is conservative: MuPDF does not bind a clip to the image it applies to, so any clip on the page whose
scissor does not contain the image bbox as a plain rectangle marks every image on that page.

## Shared xref is not one occurrence

In the foundation corpus case `shared_image_occurrence` one image XObject (one xref) is placed twice on page 0 under
two resource names (`fzImg0`, `fzImg1`). PyMuPDF `Page.replace_image(xref, ...)` (1.28.2, `pymupdf/__init__.py`)
inserts a new image, `xref_copy`s it **over the shared xref** and blanks the extra content stream, so it changes
**every** placement of that xref on every page, and leaves an orphan resource entry. It is never called here. Replacing
one occurrence of a shared xref needs per-occurrence isolation: clone the image object, add a fresh resource name in
a resource dictionary that is not shared with other pages/forms, and rewrite exactly the one `Do` operator that paints
the target placement (or its form). That operator-level rewrite is not implemented; it is the next blocker.

## Synthetic-only prototype

`synthetic_replace_unique_image(source_bytes, source_sha256, occurrence_id, replacement_png)` is a separate, explicit,
test-only function. It refuses (`status: 'refused'`, no output) unless: the bytes hash to `source_sha256`; document
metadata `keywords` is exactly `falsify-synthetic-object-fixture`; at most 16 pages; the probe is complete; the
occurrence id exists in that probe; it is an `inspected` image with one placement and one object reference; the
replacement is an RGB PNG without alpha, at most 2048x2048. Shared xrefs are refused with
`shared-xref-requires-occurrence-isolation`.

Preflight before any decode or raster:

- Replacement (`replacement-over-budget` / `replacement-invalid`): at most 16 MiB of bytes; PNG signature; first chunk
  a 13-byte `IHDR` with a valid CRC; bit depth 8, colour type 2 (RGB, so no alpha and no palette), compression 0,
  filter 0; non-zero width/height with width x height <= 2048x2048. Only then does MuPDF decode it, and the decoded
  pixmap must still be 3-channel, alpha-free and exactly the IHDR size. A header claiming 65535x65535 over a tiny
  deflate stream (decompression bomb), JPEG/GIF, RGBA/grey/palette/16-bit PNGs and truncated or CRC-broken headers never
  reach the decoder.
- Pages (`page-over-budget` for the source, `output-page-over-budget` for the output): for **every** page, MediaBox
  and rendered page rect must be finite, positive and at most 4000 pt (= px at 72 dpi) per side; the rendered page at
  72 dpi must be at most 4,000,000 px and the whole document at most 16,000,000 px. The source is checked right after
  the synthetic gate and the output right before the proof, so an oversized page is never rendered even when the
  synthetic keyword is present. The MediaBox check is deliberately conservative: a huge MediaBox with a small CropBox
  is refused although MuPDF would only render the CropBox.

It then rewrites only that image object's dictionary and samples in a
private copy (no redaction, no cover rectangle, no content-stream change) and returns the output only if a rendered
proof passes: every other page pixel-identical at 72 dpi, the target page pixel-identical outside the placement bbox
dilated by 2 px, the placement visibly changed, and a re-probe showing every other occurrence and the target bbox/
transform unchanged. Because the xref is used once, this is safe by construction; it does not generalise to real
papers, where figures are usually forms, shared, clipped or masked, and it is not exposed anywhere.

## PDF4QT feasibility (source read, not built or run)

Primary source: https://github.com/JakubMelka/PDF4QT at `master` = `905cefa6b694c013fb69f998c1b94b9f62b5abd1`
(2026-10-11). MIT (`LICENSE`, "Copyright (c) 2018-2026 Jakub Melka and Contributors"); the same MIT header is in
`Pdf4QtLibCore/sources/pdfpagecontenteditorcontentstreambuilder.cpp`.

- `PDFPageContentEditorContentStreamBuilder::writeEditedElement` re-serializes the **whole page** from edited
  elements (state difference, `q`/`cm`, clip path, then the element). Images go through `writeImageObject`, which adds
  the existing image object under a fresh `Im<n>` key in a rebuilt XObject dictionary, or `writeImage`, which encodes
  a new FlateDecode DeviceRGB image (+ SMask for alpha). So each element gets its own key, which is the per-occurrence
  isolation MuPDF lacks, but only by regenerating the page content stream; transparency groups become new form
  XObjects (`finishTransparencyGroups`).
- `UnitTests/tst_contenteditortest.cpp` covers this: `test_image_orientation_*` (plain, flipped, form XObject,
  inline, SMask, image mask, rotated, `replaced_image` = re-encode instead of reusing the object, tiling pattern),
  `test_rendered_page_is_unchanged` (zero differing pixels after rewrite for Plain/Flipped/Form/SMask/ImageMask/Tiling),
  `test_other_resources_are_preserved` (indirect resources). These are the author's tests; they were not run here.
- Availability: release `v1.6.0.0` (2026-06-14) ships `PDF4QT-Windows-1.6.0.0.zip` (30.2 MB) and an MSI, but master is
  117 commits ahead and the builder file last changed 2026-09-24 (`7dee3a06`), so the release binary does not contain
  the code read above. The CLI `PdfTool` (sources under `PdfTool/` at that commit) has fetch-images, render, redact,
  optimize, diff etc. and no content-edit/image-replace command; editing exists only in the Pdf4QtEditor GUI and the
  C++ library API.
- Build: `CMakeLists.txt` requires Qt6 (Core, Gui, Svg, Xml, Network; Widgets/PrintSupport/TextToSpeech/Concurrent for
  apps), OpenSSL 3, ZLIB, Freetype, OpenJPEG, JPEG, PNG, blend2d, Clipper2, lcms2, TBB, via vcpkg. Qt is LGPL/GPL/
  commercial, not MIT. This machine has no cmake, qmake or Qt; nothing was downloaded or built.

Practical verdict: a correct per-occurrence image replacement needs resource cloning plus isolation of the one
painting operator. MuPDF/PyMuPDF give the read side (placements, xrefs, forms, clips) but no operator-level writer;
pikepdf (not installed in the app venv) could parse/rewrite content streams with `parse_content_stream`/
`unparse_content_stream` in a separate experimental venv; PDF4QT does it by full-page rewrite behind a Qt6 C++ build.
Until one of those is built and proven on the corpus, shared/form/clipped figures stay `ambiguous`/`unsupported`.

## Tests

`app/tests/test_pdf_object_probe.py` (synthetic in-memory PDFs and the foundation corpus only, no model calls):
shared image occurrence (corpus), same object across pages, unique image, inline image (xref 0), vector vs raster,
repeated identical bbox, partial clip, form XObject (once and twice), rotated and cropped pages, budget truncation,
deterministic source-bound ids, unreadable input, no source mutation, whole-corpus probe; prototype: unique replace
with rendered proof and untouched shared page, shared refusal, identity/synthetic gates, unsupported/ambiguous refusal,
invalid replacement, identical replacement fails the proof. Bounds: total/per-page placement and drawing budgets leave
the count incomplete with no `inspected` occurrence; replacement header refusals (bomb, oversize, non-PNG, wrong colour
type/depth, bad CRC, truncated) with `pymupdf.Pixmap` patched to fail if reached; giant-page refusals (wide side,
page pixels, document pixels, MediaBox-only, non-finite, output preflight) with `Page.get_pixmap` patched to fail if
reached.
