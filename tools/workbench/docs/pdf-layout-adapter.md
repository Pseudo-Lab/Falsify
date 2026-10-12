# Experimental fixed-area layout probe

`app/local/pdf_layout_probe.py` is an **experiment**, not an editor feature. It answers one question for the exact,
unmodified user After: drawn left-aligned in a fixed font, size and line pitch, does it fit inside a given box without
entering given obstacles? It is not wired into `editor_service`, HTTP, the UI or any export, and nothing in it edits,
masks, flattens or writes a PDF.

## Result (`falsify.pdf-layout-probe.v1`)

```
propose_layout(after, bbox, font, font_size, line_height, obstacles=()) ->
{schema, experimental: true, status: fits|overflow|unsupported, reason,
 binding: {afterSha256, afterChars, textModified: false},
 fixed: {bbox, fontSize, lineHeight, alignment: 'left', obstacles},
 metrics: {kind: 'metrics-only', advances: 'pymupdf.Font.char_lengths', pymupdf, fontName, fontOrigin, verticalMetrics,
           ascender, descender, kerning: false, shaping: false, ligatures: false, sourceShapeGuarantee: false},
 region: {owner: caller|source-edit-plan, editAuthority: false, source?},
 lines: [{slot, start, end, x, top, baseline, bottom, width}] | null,
 overflow: {kind: height|unbreakable-width|slot-budget, firstUnplacedOffset, availableLines, requiredLines} | null,
 characters: {distinct, unsupported, missingGlyphs, missingCount} | null,
 policy: {fontShrink, lineHeightShrink, pageAddition, hyphenation, punctuationHanging, textRewrite, pdfMutation,
          qaMasks, productionExport: all false},
 inspiration: {repository, commit, file, license, use}}
```

- Coordinates are MuPDF page points with a top-left origin, like `falsify.pdf-edit-plan.v1`. Slot `k` has top
  `y0 + k * lineHeight`, baseline `top + ascender * fontSize` and bottom `top + (ascender - descender) * fontSize`; a
  slot counts as inside the box only when its bottom is within `EPS = 0.01` pt of `y1`.
- `lines` exist only for `fits`. They hold offsets into the After, never its text. `reconstruct(result, after)` rebuilds
  the exact After from those offsets (each line's drawn run plus the spaces/line breaks consumed before the next line)
  and returns `None` for a result not bound to that After or with gaps, overlaps or lost characters.
- `font` is a `pymupdf.Font` or an allow-listed built-in name (`helv`, `tiro`, `cour` and their styles, `symb`, `zadb`,
  `cjk`). Any other name is `unsupported`, never a silent fallback font.
- Font size and line pitch are echoed unchanged. An After that needs more lines than the box holds is `overflow`
  (`height`) with the required and available line counts; it is never shrunk, re-pitched, given extra pages or lines,
  or hyphenated.
- Line bands: a result with two or more lines (an empty paragraph's line counts) is `fits` only when every pair of
  consecutive lines is at least one band (`(ascender - descender) * fontSize`) apart; bands may touch, never overlap.
  Otherwise it is `unsupported` (`line-bands-overlap`) with no positions. This is deliberately conservative: the band
  is font-program (or source-span) metrics, not measured ink, so the probe cannot prove that real glyphs of adjacent
  lines stay apart; the refusal is not a claim that such a PDF would be corrupt. The probe never raises the caller's
  pitch or shrinks the font to escape it. Helvetica's band is 1.374 em, so a common 1.2 em pitch is refused for
  multi-line text (one line at any pitch may still fit). This metrics-only planner is not wired into export, download
  or any production block.

## Rules

| Situation | Result |
| --- | --- |
| After not a string, blank, over 4000 chars | `unsupported` |
| bbox not 4 finite ordered numbers with positive area; size or pitch not finite and > 0 | `unsupported` |
| obstacle not 4 finite ordered numbers, more than 256 obstacles | `unsupported` |
| tab, control, format (soft hyphen, joiners), surrogate, private-use or unassigned character | `unsupported` (`unsupported-character`) |
| any drawn character without a glyph in the font program's Unicode cmap | `unsupported` (`missing-glyphs`, code points listed) |
| one space-free run (URL, long word, `-0.42`) wider than the box | `overflow` (`unbreakable-width`) |
| more lines than the box holds | `overflow` (`height`) |
| two or more lines whose bands overlap at the caller's pitch | `unsupported` (`line-bands-overlap`) |
| everything placed inside the box and outside obstacles | `fits` |

Line breaking: `\n`, `\r\n` and `\r` are hard breaks; an empty paragraph still takes a line. Soft breaks happen only
at a run of U+0020 spaces (the run is consumed, not drawn) or between two non-space characters when one is CJK (East
Asian Wide/Fullwidth, Hangul jamo), never before closing punctuation or a combining mark and never after opening
punctuation. Latin, digit and sign runs are never split. Spaces at the start of a paragraph are drawn. For each line
the widest free interval between obstacles that meet the line's glyph band is used (ties: leftmost); a line whose band
is fully blocked is skipped.

## Source-derived wrapper

`propose_from_source(source_bytes, edit, line_height, *, bbox=None, obstacles=())` reads, never writes, the source:
it calls the existing `paper_inventory.build_edit_plan` contract and proceeds only when the edit is `resolved` with
exactly one line region and one style (a simple horizontal, single-style, single-column selection); anything else is
`unsupported` (`source-not-simple`). Size comes from the plan style. The font is the single page font whose base name
equals the plan font (or, only when none matches exactly, starts with it, because MuPDF truncates long span font
names; the origin then ends in `:name-prefix`): an embedded program gives its own advances (`source-embedded-program`),
a non-embedded base-14 font gives PyMuPDF's built-in metrics for that name (`base14-builtin-metrics`), and Type3,
missing or ambiguous fonts are `unsupported`. Vertical metrics are the one ascender/descender MuPDF reports for spans
of that font and size, so the default box (the plan's tight source region) matches the source character boxes.
The box is still geometry, not edit authority. The wrapper uses no QA masks and no output PDF.

## Evidence and its limits

Advances are `pymupdf.Font.char_lengths` from the installed PyMuPDF 1.28.2: no kerning, OpenType shaping, ligatures
or justification. A `fits` result is metrics-only evidence. It does not prove the source font's PDF encoding can
show these characters, that a writer would reuse the same font object, or that a renderer draws identical shapes.
Embedded CID subsets usually carry no Unicode cmap, so `has_glyph` finds nothing and the result is
`unsupported` (`missing-glyphs`) even for text identical to the source: mapping Unicode through ToUnicode and
CIDToGIDMap back to subset glyphs is not implemented. Synthetic foundation comparison (tests): for
`valid_same_length_wording`, `two_column` and `minus_sign_preservation` the probe fits the After in the source region,
and its width matches the simulated output's measured width within 0.05 pt; for `shared_image_occurrence` the wider
After overflows the tight region, as the simulated output also does; `multiline_mixed_font`,
`ambiguous_repeated_quote` and `rotated_cropped` are `unsupported`. This compares measurements only and says nothing
about full engine export.

## BabelDOC provenance and feasibility

Inspected read-only: [funstory-ai/BabelDOC](https://github.com/funstory-ai/BabelDOC) commit
`38d3896dcde9b5a940c62cf5563cadea673a64d3` (package version 0.6.4), license AGPL-3.0,
`babeldoc/format/pdf/document_il/midend/typesetting.py` and the `document_il/il_version_1.py` IR. Ideas re-implemented
here (no code copied, imported or executed):

- breakable vs non-breakable units (`TypesettingUnit.calc_can_break_line`, `LINE_BREAK_REGEX`) and CJK detection
  (`calc_is_cjk_char`), simplified to "break at spaces or next to CJK";
- characters that must not start a line (`calc_is_hung_punctuation`) or end one
  (`calc_is_cannot_appear_in_line_end_punctuation`), as kinsoku rules, but without hanging past the box;
- skipping spaces at a soft line start and continuing layout after the box is full (`_layout_typesetting_units`,
  `all_units_fit = False`) to measure an overflow;
- PyMuPDF `Font.char_lengths` as the advance source, as BabelDOC's `FontMapper` does.

Not used: `_find_optimal_scale_and_layout` (scale shrinking down to 0.1), `get_max_right_space`/`get_max_bottom_space`
box expansion, `line_skip` 1.3/1.5 multipliers, CJK/Latin half-space insertion, first-line indent, hanging punctuation
and `FontMapper` font substitution.

Working BabelDOC integration is **not proved**. `Typesetting.__init__` builds a `FontMapper` from a
`TranslationConfig`, which resolves font assets through `babeldoc.assets` (network download via httpx with upstream
selection); the package depends on onnxruntime, openai, huggingface-hub and others; and layout operates on
`il_version_1.PdfParagraph`/`PdfCharacter` IR produced by its own PDF parsing pipeline. No BabelDOC package was
installed or imported, and no font/IR adapter from `falsify.pdf-edit-plan.v1` to that IR was built. Combining AGPL
code with this repository would also need a license decision. This module is an algorithm-inspired standalone
baseline only.
