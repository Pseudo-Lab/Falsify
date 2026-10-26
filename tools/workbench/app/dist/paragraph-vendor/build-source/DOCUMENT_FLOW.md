# Opt-in flow through existing source pages

`editPdf(request, { documentFlow: true })` enables strict post-edit compaction.
`documentFlow: "compatible-groups"` compacts eligible groups and retains an
ineligible group's ordinary staged continuation pages with an explicit
`document_flow_barrier_not_compacted` warning, including source page and reason.
Retained continuation pages are not reported as successful document flow.
Omitting the option preserves the existing pagination contract.

All selected edits first finish against their original source page bindings.
After that editing engine closes, a fresh transaction opens the intermediate
PDF and reads immutable source pages separately. It fills consecutive original
destination pages before creating any terminal tail pages. It removes only the
known generated staging continuations; original pages, including blank ones,
are never deleted. A failure applying a planned group discards the transaction.
The intermediate pagination page limit remains in force: capacity that could
be reclaimed later does not bypass that initial resource bound.

## Current supported scope

At most 64 original source pages, 5,000 objects and 100,000 extracted characters
per participating page, 10,000 lines per group, full-body single-column text chains, matching
page sizes and column left edges, unrotated/uncropped geometry and top-level
unshared text. Annotations are barriers unless a trusted raw dictionary adapter
is injected as described below. Each source page's own running headers,
footers and page numbers stay fixed. Only new terminal pages receive the last
source page's declared continuation edge style and suffixed page numbers.
The first implementation uses full-body groups: `flowTop === bodyTop`. It does
not selectively move a suffix below a fixed table. A table or figure on such a
page is a barrier, even when it is above the selected edit.

Non-owned body objects, ruled tables, overlapping/side-by-side paragraphs,
widely separated text cells in a row, forms, Type3 text, unsupported glyphs,
blank/ambiguous body pages, clip paths, transparency, non-horizontal matrices,
invisible/clipping text modes, and non-BMP source characters are refused.
These conservative checks can refuse legitimate layouts. They do not provide
general table/figure semantics. Tiny straight inline paths have the narrow
source Link ownership contract described below; arbitrary paths remain barriers.

Original line shapes and spacing within each intermediate page part are kept.
A physical page boundary is replaced by a measured line pitch, not a large
vertical page gap. There is no new downstream paragraph wrapping algorithm;
original line lengths are preserved and checked against the group's measured
source column bounds. Section-break intent is not available in PDF objects;
the option explicitly authorizes flow through the eligible consecutive pages.

## Why reconstruct text objects

The pinned PDFium generator preserves an existing object's original content
stream index when it is moved between pages. A source stream-1 object inserted
at destination object index 0 can still serialize after destination stream 0,
even with its glyphs geometrically above that destination text. The negative
regression in `test/document-flow.test.mjs` records this limitation.

The bounded implementation reuses the continuation-template text snapshot and
clone machinery. All participating body text is rebuilt as streamless objects
using font references from the *same intermediate document*, exact explicit
character positions, original font size, fill/stroke, render mode and matrix
linear components. Every clone is read back to prove character identity,
glyph origins/boxes, font descriptor, size, colors, render mode and stroke
width before source objects are destroyed. Generated extraction whitespace is
excluded from source objects; literal source spaces remain in their cloned
text and positional proof. Saved text may contain only independently marked
generated-whitespace differences under the existing narrow matcher.

This is object reconstruction, not original content-stream preservation.
Marked-content semantics, tagging, exact ICC color-space serialization and
general complex text state are not promised. The saved-file QA must pass, and
independent extraction/render review is still required. No native runtime was
changed for this feature.

## Report contract, version 1

`report.pagination.sourcePageMap` retains the existing consecutive partition
of original page identities and terminal inserted pages. A group member row
also has `contentOutputPageIndices`, the sorted output pages that contain its
body content. Source edit/draft page indices remain original source indices.
Do not interpret a mixed-content destination as belonging exclusively to the
preceding source page.

`report.pagination.flowGroups[]`:

```js
{
  version: 1,
  sourcePages: [
    { sourcePageIndex, bodyTop, flowTop, floor, x0, x1 }
  ],
  outputPages: [
    { outputPageIndex, bodyTop, flowTop, floor, x0, x1, lineCount }
  ],
  contentMap: [
    { sourcePageIndex, outputPageIndices: [/* sorted, nonempty */] }
  ]
}
```

Coordinates are PDF user space, positive up, in points. Source/output page
indices are zero based. Source membership is consecutive and disjoint across
groups. Output membership is consecutive/disjoint and equals the original
identity pages plus that group's terminal continuations. Output x bounds are
the union of the measured source body ink bounds in the group. Output bands
belong to the original receiving pages, or to the terminal source template for
new pages. Content mappings must agree with the corresponding identity rows.

The saved-file checker independently recomputes every source band from the
immutable source using the shared source-only classifier; reported floors,
tops and x bounds must match those derived values. Each original destination
uses its own derived band, and a tail page uses the terminal source template.
Lowering both reported source and output floors cannot authorize margin use.
Body glyph ink, not just its vertical center, must fit the derived output band.

The saved-file checker derives expected body text with exact selected edits
from immutable source bytes, checks the whole group's order and character
conservation, exact unchanged glyph styles and single-style replacement
mapping, original destination fixed glyph positions/styles, original page
sizes, source-derived band bounds, measured line counts, overlap, off-page
glyphs and declared tail edges. Mixed-style replacement mappings outside this
bounded proof fail closed. Invalid membership cannot downgrade to a weaker
continuation check. This remains the same PDFium build, not independent QA.

Adapters must explicitly transport and validate `flowGroups` to independent QA
and use content mappings for preview navigation. Dropping the group metadata
does not grant a pass: changed formerly unedited destination pages then fail
the existing per-page checks. Hash/revision guards and immutable source draft
bindings remain necessary.

## Optional trusted Link dictionary adapter

`options.annotationAdapter` is a code-level dependency with asynchronous
`inspect`, `transport` and `validate` methods. It is never accepted from request
JSON or a transported report. The app implementation uses its already pinned
MuPDF raw object API. `inspect({sourceBytes,sourceSha256})` binds a private model
to immutable source bytes and exposes numeric annotation descriptors. Raw URI,
action, named destination and dictionary values remain private to the adapter.
Native source checks independently compare descriptor page/index/subtype/rect
against the PDFium source inventory before allowing annotations in a group.

The engine associates original Link rectangles with every intersecting source
glyph, including partially intersecting edge glyphs. It maps original character
indices through the exact selected Before/After spans, including the existing
source-proven discretionary-hyphen handling. It never searches for a repeated
link label to guess its identity. An edited linked label, overlapping ownership,
new ambiguous output ownership, multiple output pages, line splitting, or a
change in relative glyph geometry is an explicit barrier. A supported unchanged
span must have one rigid translation on one output page. Fixed edge links stay
on their own original pages.

After native body reconstruction, `transport` moves the original existing Link
PDF dictionary between output `/Annots` arrays, updating only translated Rect,
QuadPoints and owning page P. It preserves unknown dictionary members, complete
nested actions and strings; no URI is opened and no action is executed. Saved
QA re-inspects immutable source bytes, rederives moves from actual saved glyphs,
then invokes adapter validation of all original annotation dictionary semantics,
geometry and ownership. `pagination.annotationMoves` contains only numeric
diagnostics and is never authority for this saved check.

Resolved local targets must stay outside changed flow pages, including targets
of annotations owned by other pages and nested actions. When the next proposed
source page is a target of the included prefix, the planner stops before that
page and may use terminal tail pages. The minimum two-original-page chain still
applies. Backlinks into the initial changed body are barriers: arbitrary FitH/XYZ
scroll positions are not guessed to be glyph anchors. Unknown actions, action
ownership roots, tagged/shared annotations and unresolved target semantics stay
unsupported. One explicit inherited-source exception is a named destination
whose exact name and complete catalog absence are proven by the trusted adapter
both before and after output. It remains broken, receives
`source_broken_link_preserved`, and no target is invented.

Tiny straight citation underlines may be reconstructed only when one immutable
source Link rectangle uniquely owns their endpoints and associated glyphs, their
width is at most two effective source ems, and all supported segments, matrix,
draw mode, RGBA fill/stroke, stroke width, cap/join and paint relation are known.
Curves, tables/rules, wide or unowned paths, dash, marks, transparency and actual
clipping paths are barriers. A source path must match exactly one staged path
by its complete shape/style either at its original source location or at its
independently proven staged glyph translation; proximity is not identity. The
final fresh path uses the same final translation as its link glyphs. Clone and
reopened saved checks reject missing, duplicate, moved or recolored paths.
The reopened check also enumerates the actual saved page's object order and
compares each path with the exact source-owned label glyph objects selected
by its translated immutable source rectangle. Its original all-before or
all-after relation must hold for every owning glyph object; unrelated text
elsewhere on the page does not determine that relation. Reordering an
otherwise identical stroked path across its label is a failed saved check.
Native color readback does not establish original ICC/stream byte identity;
independent render review remains required. Existing staging pagination can
still reject a decoration before this post-edit phase.

Validation on the real cold-shower eight-edit case remains deliberately
distinct from synthetic success: 15 source pages produce 18 output pages,
eight edits and the saved self-check pass, but no document-flow group compacts.
The fixed table on page 6 remains a barrier. Bibliography backlinks on source
page 14 target moving body pages 10/11, so exact target protection retains that
staged group. This feature does not claim natural-flow completion for that paper.

The actual adapter integration tests run with
`FALSIFY_ANNOTATION_ADAPTER_ROOT` pointing to the app worktree containing its
`app/src/document-flow-annotations.mjs` and pinned MuPDF vendor. Without this
explicit dependency, standalone tests skip only the app-adapter integration
cases and continue to enforce the annotation barrier.
