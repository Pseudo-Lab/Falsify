# Source-derived PDF edit plan

`app/local/paper_inventory.py` reads the immutable source PDF (PyMuPDF/MuPDF, the already installed
dependency) and records, for each selected Before/After edit, where the selected source text is and how it is
styled. It is a foundation for controlled research-copy editing and independent QA, not a table/figure
editor and not a fidelity claim. Nothing in it edits, repairs, flattens or writes a PDF.

## Private plan (`falsify.pdf-edit-plan.v1`)

```
{schema, sourceSha256, policy: 'document-consistency-text', status: resolved|partial|unavailable,
 edits: [{id, pageIndex, beforeSha256, afterSha256, status: resolved|ambiguous|unavailable,
          regions: [[x0, y0, x1, y1], ...], styles: [{font, size, color}]}]}
```

- `sourceSha256` is the SHA-256 of the exact source bytes; `beforeSha256`/`afterSha256` hash the exact
  selected UTF-8 strings (no trimming or normalization). The plan never contains document text.
- `regions` are tight per-line rectangles around only the selected source characters, in MuPDF points of the
  unrotated, uncropped page (top-left origin). Every value is finite, `x0 < x1`, `y0 < y1`, inside the page,
  under 98% of the page width and 25% of its height; nothing page-wide.
- `styles` holds the single source `{font, size, color}` (`color` integer RGB) shared by every selected character.
- Plan `status` is `resolved` when every edit resolved, `unavailable` when none did, `partial` otherwise.

Coordinates and styles come only from the source bytes, never from an HTTP request, an editor report or an
output file. `validate_plan(plan, sourceSha256, edits)` accepts only a well-formed plan bound to that source
hash and those exact Before/After strings; QA can use it, or rebuild with `build_edit_plan`.

## Anchoring

The selected Before is matched on its labelled source page after collapsing white-space runs (line breaks
included) to one space. Signs, digits, operators, hyphens, case and ligatures compare exactly, so `-0.5`
never matches `−0.5` and `a - b` never matches `a + b`. Conservatively:

| Situation | Edit status |
| --- | --- |
| exactly one match, one style, horizontal text, identity page | `resolved` |
| two or more (including overlapping) matches on the page | `ambiguous` |
| no match, ligature glyphs, mixed font/size/colour, vertical or rotated text | `unavailable` |
| rotated page, CropBox ≠ MediaBox, MediaBox not at the origin | `unavailable` |
| non-PDF, unreadable, encrypted, PyMuPDF missing, page/char/span/region budget exceeded | `unavailable` |

## Export integration

`editor_service.PdfEditorService.export` builds the plan with `plan_isolated` (a child of the server
interpreter, isolated mode, minimal environment, hard timeout) after validating the request and before the
Node editor runs, then revalidates it against the source hash and the selection. Any planner failure becomes
the unavailable plan; an unresolved plan never blocks the export or changes the Node/web-bridge wire request.

The same plan is passed as keyword `edit_plan` only to the default production `pdf_quality.inspect_isolated`,
and only when that function accepts the keyword; an explicitly injected checker keeps the legacy
five-positional-argument call. Independent QA reports are still sanitized by `pdf_quality.sanitize`.

The response adds only a fixed public summary:

```
verification.editPlanSummary = {schema: 'falsify.pdf-edit-plan-summary.v1', status, plannedEdits, resolvedEdits,
                                policy: 'document-consistency-text'}
```

The private plan (hashes, coordinates, font names) is never printed, logged or returned.

## Inventory

`build_inventory(source_bytes, page_indices=None)` returns a private bounded per-page bbox list of text lines,
images and vector paths (at most 64 pages and 2000 items per kind, with a `truncated` flag and
`supportedGeometry` for rotated/cropped pages). It describes what exists for future adapters and claims no
ability to edit any of it. It is not wired into export.

## Limits

- Text drawn invisibly (render mode 3), clipped or covered still counts as source text for anchoring.
- Hyphenated line breaks are not joined: a Before that crosses `re-`/`sult` stays unavailable.
- Font boxes come from MuPDF character boxes (ascender/descender), so a region can touch the adjacent line.
- Reading order is MuPDF's block/line order; multi-column text that crosses columns is matched in that order.
