# Regional QA of edited PDF pages

`app/local/pdf_quality.py` independently re-reads every exported PDF with MuPDF. Unedited pages are compared
whole. Edited pages are additionally checked **regionally** by the sibling `app/local/pdf_regions.py`. This is
implementation-level evidence about this one output, not a typographic, scientific or human review.

## Where the regions come from

- QA locates each selected Before in the immutable **source** page itself (whitespace removed, nothing else
  normalized, so signs, digits and operators keep their meaning). A missing or repeated anchor is never guessed;
  that page's regional checks become warnings.
- The excluded area is the tight per-line box of the selected **source** characters plus a fixed 1 pt bleed. Whole
  lines, whole pages and anything the output defines are never excluded.
- A supplied private edit plan (`edit_plan=`, schema `falsify.pdf-edit-plan.v1`) is only cross-checked against the
  located plan (code `edit_plan`): same source hash, Before/After hashes, page and regions/styles within 1.5 pt.
  Caller ids are labels only (QA numbers its own edits `edit-N`). A plan that is more conservative
  (ambiguous/unavailable, no regions) is consistent; a malformed, forged or widened plan is a `warning` and is
  ignored. It can never widen or move the exclusion.

## Codes (report schema `falsify.pdf-quality.v1`)

| code | failed (definite) | warning (uncertain) |
|---|---|---|
| `edited_page_render` | a sample outside the sealed regions moved more than 40 levels (new graphic, white cover, damaged figure or paragraph) | kept text of the edited line slid outside the sealed regions (longer/shorter After, re-justified spacing); float32 drift re-antialiasing unchanged glyphs (below); reflow; continuation; oversized regions |
| `edited_page_text` | unedited text on the edited page lost, restyled (size, color or disproven metrics) or moved; kept same-line text restyled | extra output lines; reflowed or continued text; a font name changed alone |
| `edited_region_style` | an After glyph has a different size (±max(0.25 pt, 3%)) or RGB color (±8) from the selected source, or another font name whose advance the source's own glyphs of that character disprove (±max(0.3 pt, 10%)) | After position unknown after reflow; a font name changed alone (fallback, embedding or supplemental glyph) |
| `edited_region_visible` | an After letter leaves no ink, kept same-line letters lose ink they had, or overlapping invisible text | After position unknown |
| `edit_plan` | — | supplied plan inconsistent with the located plan |

Only definite corruption is `failed`. Rotated/cropped pages, continuation groups, repeated anchors, page/character
budgets and an assumed page mapping make the regional codes warnings (limitation `regional_partial` or `budget`), so
they never become a new blanket download block. If the sibling module cannot load, the regional codes are
`unavailable`, never `passed`.

A font name is not proof of a visual change: an engine may draw a glyph the source subset lacks from a supplemental
fallback font, or re-embed the same face under another name. A font name mismatch with size and color within tolerance
is therefore a `warning` (limitation `regional_partial`), never `passed`. It becomes `failed` only when the source page
itself holds the same character in the expected style and its advance width disagrees beyond tolerance. No font is
treated as equivalent to another by name. The raster comparison outside the sealed regions is unaffected, so a
visibly different face on unedited or kept text is still measured there.

## Float32 drift of unchanged glyphs

An engine that re-serializes the page can move every unchanged glyph by a float32 rounding step (about 0.0001 pt).
That is invisible, but when a glyph origin sits on MuPDF's sub-pixel glyph quantization boundary (for example an odd
1/8 pt) the step re-antialiases its edges by more than 40 levels: a real browser export showed 12 such pixels in one
unchanged paragraph glyph, with identical text, styles and vector drawings. These pixels are a `warning` (limitation
`regional_partial`), never `passed`, and only when every one of them

- lies on an unedited glyph (or a kept same-line glyph that did not slide) matched in place to its source glyph with
  the same character and exact style (font name, size, color), whose position moved by more than 0 and at most
  0.002 pt (`DRIFT_TOL`);
- belongs to a glyph whose rendered ink differs by at most 8% (`NOISE_INK`) between source and output;
- has no drawing, image, annotation or unmatched output character on that glyph that differs between source and
  output (a vector tick or white cover is a drawing, so it stays `failed` even if its ink were small).

A pixel on blank page, on a glyph that did not drift, on a recolored, resized or renamed glyph, or on a glyph moved
beyond 0.002 pt (and not part of a rigid run, below) is still a definite `failed`. Beyond 4096 such pixels
(`NOISE_MAX`) nothing is classified.

### Rigid runs up to 0.02 pt (`RIGID_TOL`)

An engine that re-emits text positions in floating point (for example a re-derived leading) can translate a whole run
of unchanged glyphs by a few thousandths of a point; a real editor output moved a kept same-line stretch by 0.011/0.008
pt and following lines by up to 0.016 pt. Such glyphs also count as drifted when they form a **rigid run**:

- at least two consecutive glyphs of one unedited line, or of one kept stretch of an edited line between selections;
- each with the same character and exact style (font name, size, color) as its source glyph;
- all moved by one common nonzero vector (every box and baseline delta within 0.002 pt of the run's first glyph, box
  shape kept), of at most 0.02 pt in every coordinate (`RIGID_TOL`, under 1/30 of a raster pixel at 96 dpi).

The same ink (8%), drawing, image, annotation and unmatched-text proof as above still has to explain every changed
pixel, so the result is at most a `warning`, never `passed`. A single glyph, a run whose glyphs moved differently, a
restyled glyph, a run moved beyond 0.02 pt, or a kept stretch that slid along its line (a longer/shorter After) is
never rigid. `DRIFT_TOL` itself is unchanged.

This is a tolerance, not a proof of invisibility: a 0.02 pt translation is accepted for a run whose pixels re-quantize
within the ink rule, and nothing checks that the translation came from float re-emission rather than a deliberate
shift of that size. Conversely, cumulative leading error beyond 0.02 pt on a long paragraph (each line a little
further off) still fails whenever it changes pixels, even if it is equally invisible.

## Isolation

`inspect_isolated` runs the same code in `python -I` with a minimal environment. `pdf_regions.py` is loaded by
absolute path next to `pdf_quality.py`, not through `sys.path` or the working directory, so the isolated child runs
the regional checks. Reports carry fixed codes, statuses and output page numbers only: no document text, plan
coordinates or paths.

## Known limits

- Differences inside the zones where After or shifted kept text lands are at most warnings; a graphic drawn exactly
  there is not proven by the raster (white covers over text are still caught by the ink check).
- Reflowed (non same-placement) edited pages are compared by text and After style/visibility only; their raster is a
  warning, not a proof.
- Rotated or cropped pages and vertical text are not regionally compared.
- Proportional-font edits whose After width differs from the Before almost always shift kept text and therefore
  report `warning` rather than `passed`.
- A renamed or fallback font for a character the source page never draws in that style cannot be checked by metrics;
  it stays an unverified `warning`.
- Drift noise is classified from MuPDF's own drawing, image and annotation lists plus ink: a shading or other content
  those lists do not report, drawn on a drifted glyph and keeping its ink within 8%, would be a `warning`, not a
  `failed`.
- Rigid runs widen the drift tolerance from 0.002 pt to 0.02 pt for runs of at least two glyphs (above); a single
  glyph keeps the 0.002 pt limit.
- `edited_text_order` first reads lines in MuPDF's geometric sort order. Column growth can re-pair side-by-side lines
  and falsely appear to lose text. A definite-loss verdict becomes `warning` only when an additional block-order
  comparison equals the source with exactly the selected edits. This additional proof retains hyphens and minus signs;
  it does not use a character bag or forgive deletions, additions or substitutions. Different block segmentation may
  still conservatively refuse an otherwise correct output. Position, style and visibility checks remain separate.
