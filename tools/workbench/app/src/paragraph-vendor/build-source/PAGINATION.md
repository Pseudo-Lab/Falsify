# Continuation pages (long After text)

Status: experimental, narrow scope. Same-engine self-check only; independent
extraction/rendering QA is still required for every output.

## What it does

When a reflowed edit grows past the page's body floor, the edited paragraph
and the body text that follows it on the same page form one flow. The floor
is the top of the bottom edge content (e.g. the page number) + 2pt, raised
to the bottom 10% of the page's content extent (the band the saved-PDF
check reads as footer content), but never above the lowest source body
text:

1. The edited paragraph is re-laid out at its source column width and line
   pitch (existing repair). A surgical commit that stays inside its column
   is kept as committed; if it wrapped onto more lines, its growth is the
   drop of its last baseline (text-matrix origin), so followers move by
   whole source lines and are pushed (or continued) like a resized edit.
   A re-layout whose glyph ink still ends past the column is narrowed once
   by the overshoot (unrotated, unoffset pages only). The correction,
   including the tolerance, must be at most 10% of the width and leave a
   positive width; otherwise `ink_overshoot_unrepaired` warns and the
   saved-PDF column self-check remains responsible for rejecting unsafe ink.
2. The flow is grouped into actual line objects. Each following line is
   shifted down by the growth above it (as the cascade does).
3. Lines are assigned in order to the source page while they stay above the
   floor, then to new continuation pages; each continuation page starts with
   its first line's top at the source page's body top (`planFlow`).
4. The source page's content is generated first (so every object has a
   content stream), then continuation lines are moved, in source object
   order, with `FPDFPage_RemoveObject` / `FPDFPage_InsertObject` onto pages
   created with `FPDFPage_New` directly after the source page. Fonts are
   re-bound by object number into the new page's resources by PDFium's
   content generator. The source page is regenerated and reloaded.

Lines are the original text objects: font, size, colour, run styling, column
x position and line pitch are unchanged. Nothing is rasterized, flattened,
scaled or truncated.

## What continuation pages are not

- Not a free re-layout of headers/footers. Their edge text is copied in
  source style only (see "Continuation edge style" below); no continuation
  label is synthesized. Original page numbers stay on their source pages and
  are not renumbered.
- They do not establish invisibility of the edit or complete preservation of
  the original document's layout: the document has more pages than before,
  and continuation page numbers carry a visible decimal suffix.

## Continuation edge style (`source-number-suffix`, version 1)

`src/continuation-template.mjs`. Edge objects are the source page's
top-level objects whose bounds centre lies outside `[floor - 0.5,
bodyTop + 0.5]`. Each edge text object is re-created on every continuation
page with the source object's font object, font size, matrix, fill/stroke
colour, stroke width and render mode. Running text keeps its exact
per-character positions (`FPDFText_SetPositions` with the source glyph
origins in text space, so TJ kerning, Tc and Tw survive as absolute
offsets). A standalone Arabic page number (object text `/^\s*\d+\s*$/`)
becomes `<source>.<ordinal>` (`10` -> `10.1`, `10.2`, ...) at natural
advances, shifted so its inked extent keeps the source anchor (centre within
2pt of the page centre, else right edge in the right half, left edge in the
left half). Original edge objects are only read.

Fail-closed codes (severity error, no PDF): `continuation_edge_graphics_unsupported`
(path/image/shading/form intruding beyond the physical edge zone), `continuation_edge_clip_unsupported`
(edge text with a clip path), `continuation_edge_text_layout_unsupported`
(chars off one text-space baseline, missing origin/box),
`continuation_edge_style_unsupported` (blend mode / soft mask),
`continuation_page_number_unsupported` (roman, `- 4 -`, `3 of 9`, `Page 3`, ...),
`continuation_page_number_ambiguous` (different standalone numbers),
`continuation_page_number_spacing_unsupported` (source digits not at natural
advances), `continuation_page_number_glyph_missing` (font cannot draw `.` or
a needed digit: no width or no outline), `continuation_edge_clone_failed`,
`continuation_edge_clone_mismatch` (FPDFText read-back of a clone differs
from the source glyphs: characters, origins/boxes within 0.05pt, page-number
digits moved by one common dx, anchor within 0.1pt, non-degenerate suffix),
`continuation_edge_snapshot_drift` (edge text changed while the source page
content was regenerated).

Engine notes: the edge snapshot is taken again after the source page's
content is generated, because font de-aliasing there may replace edge objects
and their handles. On each new page the clones are inserted and generated
first; moved body objects are then inserted between them and the page is
generated again. One generation with both stream-less clones and moved
objects (source stream index 0) lets PDFium overwrite the clones' new stream,
which was reproduced as clones missing after save.

Helper API for independent checks (pure, from a source snapshot):
`snapshotPageEdges(engine, floor, bodyTop)`, `expectedPageEdges(snapshot,
ordinal)`, `classifyEdgeText`, `continuationNumberText`, `anchorOf`.

## Scope (anything else is an explicit `*_unsupported` error)

Supported: one top-level single-column body flow below the edited
paragraph on an unrotated page whose MediaBox starts at the origin, with no
CropBox offset and no Type3 segments. Unowned zero-size spacing objects and
soft-hyphen objects sitting on an untouched flow line move with that line.

Rejected before anything moves (`LAYOUT_UNSUPPORTED`):
`pagination_unsupported_multi_column_flow`,
`pagination_unsupported_foreign_object_in_flow` (images, paths, or text not
assignable to a flow line inside the flow band),
`pagination_unsupported_edge_paragraph_in_flow`,
`pagination_unsupported_rotated_page`,
`pagination_unsupported_cropped_or_offset_page`,
`pagination_unsupported_type3_segments`,
`pagination_unsupported_non_top_level_text`,
`pagination_unsupported_shared_objects`.
Other stops: `pagination_line_exceeds_body`, `pagination_flow_not_monotonic`
(`REPAIR_FAILED`), `pagination_budget_exceeded` (`PAGINATION_LIMIT`).

## Options and budgets

`editPdf(request, { allowPagination = true, maxNewPages = 8 })`.
`maxNewPages` is a document-wide budget, integer 0..32. With
`allowPagination: false` overflow stays `pagination_unsupported`. Existing
limits are unchanged (64 edits, 4000 characters per text). Planning is
bounded: every page takes at least one line. Any failure discards the whole
document; `sourceBytes` is never modified.

`EDITOR_CAPABILITIES.pagination` describes this scope (`supported: true`
only for it).

## Page map contract

Pages are processed in source order. After continuation pages are inserted
behind source page `k`, every later source page `p` is addressed at
`p + added`; cached engine pages above `k` are closed and reloaded. Untouched
downstream page contents are never modified.

`report.pagination`:

- `pages: { source, output }`, `addedPages`
- `sourcePageMap[]`, one entry per source page:
  `{ sourcePageIndex, outputPageIndex, continuationPageIndices[] }`; entries
  with continuation pages also carry `lineCounts[]` (planned lines per
  continuation page), `keptLines`, and the body band `bodyTop` / `floor`
  (PDF user-space y), and `continuationStyle: { version: 1, policy:
  "source-number-suffix", applied: true }`.
- `continuationStyle: { policy: "source-number-suffix", applied: true,
  copiedPages }` after a passing self-check when pages were added.
- `flow[]` per continued source page: `outputPageIndices`, `bodyBand`,
  `expectedText` and `outputParts` as `{ sha256, chars }` (plus `text` only
  with `includeFlowText: true`), `measuredLines` (`{ planned, measured }`,
  measured from saved glyph boxes), `textEqual`.

`report.selfCheck.page_count` is `{ source, output, expected, added }`.

## Self-check through the map

`inspectSavedPdf(..., { sourcePageMap })` reopens source and output:

- output page count must equal `source + added`;
- every unedited source page's text equals its mapped output page's text;
- for a continued page, text inside the body band `[floor, bodyTop]` of the
  output page followed by each continuation page must equal the source page's
  body-band text with the edits applied, exactly and in order (not a word
  bag). A page-end `-` is joined without a space only where the source text
  has PDFium's soft hyphen (U+0002) at that point; all other boundaries are
  a space;
- glyphs outside the band (headers, footers, page numbers) must be the same
  characters at the same positions (0.5pt);
- continuation pages: same size as the source page, no glyph outside the
  band or off page, measured line count equals planned, columns within the
  source page's text extents, no new overlaps (pairs consecutive in text
  order on one baseline, e.g. kerned "fi", are excluded on both sides).

## Known risks

- Edge clones cannot carry a source clip path, so an edge text object with
  any clip path (FPDFClipPath_CountPaths > 0, including a page-level clip
  around all content that cuts into it) is refused with
  `continuation_edge_clip_unsupported`. A runtime that does not export
  FPDFPageObj_GetClipPath/FPDFClipPath_CountPaths cannot detect clipping
  and copies such edges unclipped. Text-render-mode clipping (Tr 4-7) is not
  inspected separately. Observed on the candidate runtime: a rectangular
  clip that fully contains the edge object is not reported for it (no
  visible effect), so it is not refused. Clones also do not carry marked-content (e.g.
  `/Artifact`) tags or extended graphics state beyond colour alpha.
- Glyph availability for the suffix is a width + outline check through the
  font's Unicode mapping; a subset font whose `.notdef`-like outline is
  reached by that mapping is not distinguished from a real glyph.
- Single-digit page numbers give no digit pair to confirm natural spacing; a
  source Tc/Tz on them is not reproduced on the suffix.
- Objects moved from different source content streams keep their stream
  index (PDFium exposes no setter); on the new page they are written grouped
  by stream. A resulting order change is caught by the ordered text check
  and fails the edit; it is not repaired.
- Surgical growth is measured from text-matrix baselines; without
  FPDFPageObj_GetMatrix, or for rotated/skewed text objects, it falls back to
  the font-box bottom versus glyph-bounds bottom, which can differ by a
  descender. Before 2026-10-19 surgical growth was ignored entirely, so the
  following paragraphs were overlapped (QA finding F2).
- Header/footer detection is heuristic: a paragraph is edge content only if
  it is at most 60 characters, 12 words and 2 lines and lies fully inside
  the top/bottom 10% of the page. A longer running header is body text: it
  is not copied onto continuation pages and the body band starts at it.
- The self-check's edge glyphs on an edited page are whole lines that lie
  fully inside that 10% band; a body line straddling the band boundary is
  body, not a partially moved header.
- Same PDFium build for editing and self-check; independent extractors and
  rendering review remain required.
- Inherited save precision: decimal MediaBox numbers can be serialized at
  float32 precision. A synthetic A4 fixture changed by about 0.00003 pt;
  untouched content streams and text were identical, and MuPDF/PDFium pixels
  matched, but Poppler's raster differed. An isolated page-box restore and
  reverse-perturb control reproduced/eliminated the effect. No universal
  byte-exact geometry or cross-renderer pixel-identity claim is made.


## Publisher-page paragraph reflow (2026-10-27)

Long single-line publisher footers can exceed the short-text heuristic. A
separate page-number paragraph on the same baseline within the physical
bottom band corroborates them as fixed footer text. This prevents their
left margin from being mistaken for a second body column.

A spatially adjacent three-object fraction (`7`, `/`, `15`) on one baseline
uses `7.1 / 15` on the first continuation: the numerator keeps its right
anchor, the separator and denominator keep their exact source style and
positions. A separate publisher year is fixed only when adjacent month/day
objects corroborate it. Other numeric candidates still fail as ambiguous.

Fixed graphics wholly inside the physical top/bottom 10% edge band remain
on their original page and are omitted on text-only continuations, with
`continuation_fixed_edge_graphics_not_repeated`. Graphics intruding into
the body remain unsupported. Short zero-height inline underline paths can
travel with a unique width-matching body text line; table rules, filled
shapes and ambiguous marks remain unsupported. Link annotation actions are
not migrated by this object-based flow.

`sourcePageMap[].flowTop` optionally identifies the top of the edited body
flow separately from `bodyTop`. Text above it, including table text, must
stay at its exact original glyph positions/styles. Only the body below it
is concatenated with continuation text for order verification. This avoids
misreading a PDF's original table/body content-stream order as an appendix.

Before matching accepts a visible hyphen for PDFium's U+0002 discretionary
hyphen only when the source paragraph proves a letter, the marker, one
whitespace character, and a letter at the next source line's `off`. The
original Before remains in the request/report. No literal hyphen is removed.
Saved-flow verification separately reports source typography normalization:
source-marked discretionary hyphens are joined before full reflow;
PDFium may expose additional word spacing after reflow. The saved check
does not erase visible output hyphens to hide a misspelled word.
Every non-space character must remain in order, existing word spaces must
remain, and every requested After must occur with its requested word spaces.
This warning does not establish typographic identity or independent visual QA.


Independent local acceptance found a remaining renderer limitation on the
cold-shower paper: all 139 source-page vector drawings retained their
geometry and widths, but PDFium regeneration changed 137 table-rule fills
from source ICC-derived RGB approximately (0.581415, 0.589273, 0.599481) to
8-bit DeviceRGB (0.576471, 0.588235, 0.596078). This produces a small visible
pixel difference on the edited page. Public colour setters only expose
8-bit RGBA; exact original ICC/stream preservation is not guaranteed by
this repair. Unmodified source pages remain untouched.

`sourceParagraphText(paragraph)` exports source-proven logical selection text
for adapters, leaving raw runs for geometry/style. Both logical quotes and
visible line-end-hyphen quotes bind to the original raw character spans.
