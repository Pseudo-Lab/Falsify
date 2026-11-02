# Paper layout tools

The layout agent uses 23 application commands. Open a PDF-derived LaTeX baseline or a source project, expand **고급 · AI 레이아웃 조정**, enter the layout request, and start. Results include a candidate PDF, source ZIP and tool record. The existing PDF editor and RED/BLUE routes remain available.

## Commands

| Command | Input | Result |
| --- | --- | --- |
| `inspect_document` | query, page, kind, offset, limit | Blocks, source/current positions, fonts and images |
| `get_block` | blockId, text offset/limit | Selected source block and its associated geometry/assets |
| `read_reference` | pages, offset | Original PDF text and source regions |
| `read_source` | path, chunk or before | Current LaTeX source chunk |
| `render_reference_pages` | pages | Original page images |
| `render_pages` | pages | Candidate page images |
| `render_region` | document, pageIndex, bbox, coordinateFrame, scale | Enlarged display rectangle |
| `update_layout` | blockId and layout values | Updated spacing, type size, width, alignment or placement |
| `restructure_source` | plan with all unit IDs | Front matter, columns, body order and running furniture |
| `replace_source` | path, before, after | One supported literal layout setting |
| `inspect_fonts` | text, offset, limit | Project font inventory and measured glyph coverage |
| `set_typography` | fontPath or family, bodySizeBp, leadingBp | Document typography |
| `read_table` | tableId/blockId/page, rowOffset, rowLimit | Table structure and paginated cell content |
| `rebuild_table` | table or owned blocks, column widths, span, header option | Re-typeset cells with current values and precision |
| `get_figure` | blockId or assetPath, offset, limit | Figures, caption groups and project image paths |
| `place_figure` | blockId, dimensions, span, placement | Figure/caption arrangement with retained aspect ratio |
| `replace_figure` | blockId, allowed assetPath | One image occurrence replaced |
| `compile_pdf` | current project | Generated PDF and compiler findings |
| `inspect_pdf` | current generated PDF | Geometry findings and coverage |
| `compare_document` | current PDF | Content, numeric, link and asset differences from the pre-layout PDF |
| `checkpoint` | label | Saved source revision and matching PDF when available |
| `restore_revision` | revisionId | Saved source and its matching PDF |
| `finish` | message | Candidate and run record |

## Action format

Commands carry their own arguments:

```json
{
  "tool": "update_layout",
  "args": {"blockId": "body-1", "leadingBp": 14, "gapAfterBp": 3},
  "message": "본문 행간과 문단 간격을 조정합니다."
}
```

The provider schema uses null for unused optional fields. The companion removes them and validates the selected command. The application also accepts the earlier seven-field action format for existing clients. `app/src/paper-layout-tool-catalog.mjs` defines commands and arguments; the build generates the companion's JSON catalog from it.

## Editing and comparison

The captured pre-layout PDF already contains the selected RED changes. Content comparison uses that PDF as its baseline, so a layout pass keeps the chosen attack intact. Exact source payloads, normalized supported source syntax and extracted PDF tokens are separate measurements. Reading-order observations and image/font checks accompany them.

Use display coordinates from the top left for crops. The region tool accepts `pdfjs-display` and `mupdf-display`. Raw SyncTeX positions identify source locations; they need a page transform before use as display rectangles. CropBox, rotations and UserUnit are covered by synthetic rendering checks.

Replacement PNG/JPEG files are added through **교체할 그림 · 선택 사항** before starting. The agent can select those project paths for a specific occurrence. Existing copies of a shared image remain unchanged.

Typed footer placement inserts a flow-owned footnote, letting TeX reserve the current output column. The older source-coordinate running-furniture plan retains its existing placement behavior. Table rebuilding requires observed cells and owned current blocks. It preserves current cell strings, including selected RED values; unsupported ownership is returned with the unmatched fragments.

Checkpoints can contain source before PDF generation. Restoring such a revision returns the source with PDF status pending; the previous generated candidate has a separate download. The run record lists pages and crops actually delivered to model decisions. Coverage describes those observations.

The developer validation covers source and reconstructed fixtures, table rebuilding, shared-image occurrence replacement, font coverage, rotated/cropped regions, revision recovery and the existing application regression suite. Detected cells may contain multiple verified text runs. An original single-column source table can become a header-repeating `longtable` when its preamble loads the package; an existing source `multicolumn` header is retained. A 90-row output from the actual tool was compiled by browser BusyTeX and checked for all rows, repeated headers and one caption.

Detected merged PDF cells, reconstructed long-table pagination, two-column breakable tables, multirow headers and arbitrary LaTeX macros retain their current support limits. Public deployment and runtime replacement are separate from this development change.
