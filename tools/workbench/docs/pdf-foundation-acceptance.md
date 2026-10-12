# PDF editor foundation — synthetic acceptance corpus

`app/tests/pdf_foundation_corpus.py` generates a small, deterministic regression corpus for the PDF editor
foundation (edit plan, regional QA, final preview). `app/tests/test_pdf_foundation_corpus.py` validates only the
generator; it asserts no QA verdict. Passing these tests means the fixtures are what they claim to be — it is
implementation-ready evidence, not a fidelity or scientific approval.

## What the corpus is (and is not)

- Every PDF is generated in memory by the installed PyMuPDF from fixed synthetic sentences. No real paper,
  researcher record, model output or private text is read, copied or written; nothing is persisted to disk.
- Bytes are test fixtures, not publication artifacts. They are byte-identical across rebuilds and fresh
  interpreters for a given PyMuPDF version (no `/ID`, no metadata dates).
- Each document has two pages: page 0 carries the selection, page 1 is an untouched control page whose text and
  72-dpi raster are identical in source and output (rendering-noise control).

## Helper interface

```python
import pdf_foundation_corpus as corpus          # app/tests on sys.path
corpus.CASE_IDS                                  # fixed order, 15 ids
case = corpus.build_case('two_column')           # or corpus.build_corpus()
case['source'], case['output']                   # bytes
case['edits']                                    # [{pageIndex, before, after}] as selected
case['pageMap'], case['pageCount']               # identity sourcePageMap, {source, output}
case['selected']                                 # [{pageIndex, regions, styles}] read from the source
case['expected']                                 # see policy below
corpus.page_regions(pdf_bytes, page_index, text) # tight per-line rects of an on-page anchor
```

A QA matrix can call, for example,
`pdf_quality.verify_pdf_quality(c['source'], c['output'], c['edits'], c['pageMap'], c['pageCount'])` and, once
available, pass `edit_plan=paper_inventory.build_edit_plan(c['source'], c['edits'])`.

`selected[i].regions` are tight rectangles, one per line (per occurrence for an ambiguous anchor), in MuPDF page
space: unrotated points measured from the CropBox top-left, exactly as MuPDF search/extraction reports them.
`styles` are `{font, size, color}` with `color` an integer RGB, read from the source spans that touch the regions.
They are reference values for comparing an independently built edit plan, not masks to trust from output.

## Acceptance policy — three separate questions

1. **Outside preservation** (`expected.outsidePreservation`): everything not selected — other paragraphs, the
   rest of the edited line, signs and digits, vector figures, images, headers, other pages — must survive. A
   defect here is a regression the foundation QA should report (`failed` or at least `warning`).
2. **Inside typography** (`expected.insideTypography`): the replaced text should keep the source font, size and
   color at the source position. A defect here (red glyph, different font/size) is a style finding; it is not an
   outside-preservation failure and must not be merged with one.
3. **Scientific gold** is out of scope. Whether a wording change is correct, faithful or meaningful is never
   decided by this corpus or by render QA. "Valid" below means only "rendering-consistent".

`expected.qaGate` is the policy target: `must-not-fail` for benign cases (a `failed` verdict is a false
positive; `warning` is allowed) and `must-not-pass` for defects or ambiguous anchors (a `passed` verdict is a
miss). `expected.planStatus` is the target edit-plan status (`resolved`, `ambiguous`, `resolved-or-partial`,
`none`); an ambiguous anchor must never be resolved by guessing, and rotated/cropped/multiline cases may be
`partial` but never a false pass. `expected.capability = true` marks cases the engine at base `a8d8b9f` is not
expected to recognise: a matrix records the observed verdict for those as a capability measurement instead of
gating on it. Promoting a capability case to a gate is a deliberate later decision.

## Cases

| id | kind | outside | inside | plan | gate | capability |
|---|---|---|---|---|---|---|
| `valid_same_length_wording` | same-length wording change at the same position | preserved | consistent | resolved | must-not-fail | |
| `edited_glyph_red` | edited word rendered red | preserved | defect | resolved | must-not-pass | yes |
| `edited_font_size` | edited word in Times 13pt | preserved | defect | resolved | must-not-pass | yes |
| `damaged_unselected_paragraph` | same-page unselected paragraph loses words | defect | consistent | resolved | must-not-pass | |
| `damaged_unselected_vector` | simple vector figure on edited page changed | defect | consistent | resolved | must-not-pass | yes |
| `white_overlay` | white rectangle over an unselected line | defect | consistent | resolved | must-not-pass | |
| `moved_header` | header on edited page moved 8pt | defect | consistent | resolved | must-not-pass | yes |
| `ambiguous_repeated_quote` | selected quote occurs twice | preserved | consistent | ambiguous | must-not-pass | yes |
| `multiline_mixed_font` | selection spans two lines, bold + regular | preserved | consistent | resolved-or-partial | must-not-fail | |
| `two_column` | edit in right column beside a similar left line | preserved | consistent | resolved | must-not-fail | |
| `minus_sign_preservation` | `-0.42` → `-0.47`, unselected `-3.1` kept | preserved | consistent | resolved | must-not-fail | |
| `minus_sign_erased` | unselected `-3.1` becomes `3.1` | defect | consistent | resolved | must-not-pass | yes |
| `shared_image_occurrence` | one image XObject placed twice | preserved | consistent | resolved | must-not-fail | |
| `rotated_cropped` | edited page CropBox + `/Rotate 90` | preserved | consistent | resolved-or-partial | must-not-fail | yes |
| `noop_roundtrip` | re-saved, cleaned, no edits | preserved | n/a | none | must-not-fail | |

Signed negatives use plain ASCII hyphen-minus; the generator validation asserts the sign is retained in the
benign case and removed only from the unselected value in the erased variant (no U+2212 or soft-hyphen
substitution).

## Limits

- Base-14 fonts only (Helvetica, Helvetica-Bold, Times-Roman); no embedded subsets, CID fonts, ligatures, kerning,
  U+2212 glyphs, tables, reflow, continuation pages or real scanned content. These belong to later corpora.
- The simulated outputs are re-rendered by PyMuPDF, not produced by the PDFium editor; they model outcomes, not the
  editor's byte structure.
- The capability flags describe the engine at base `a8d8b9f` and need revisiting when regional QA lands.
- Determinism is guaranteed for one PyMuPDF version; a different version may change bytes but not the expectations.
