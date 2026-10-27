# Paper layout components

The compositor derives body type size, local paragraph sizes, heading treatment and column evidence from the input PDF. It does not rewrite the paper into a fixed journal template. Text and selected replacements remain data passed to Typst, not executable markup.

## Components and reuse

| Component | Use | Integration status |
| --- | --- | --- |
| Typst, pinned by the existing browser runtime | Paragraph shaping, line breaking and page layout | Production compositor; source-relative style profile and local leading |
| [Typst templates](https://github.com/Shinick-Han/templates) | Reference academic spacing and grouping conventions | Reference fork; no paper contents or template assets copied |
| [BabelDOC fork](https://github.com/Shinick-Han/BabelDOC/tree/feature/falsify-paragraph-edit-20261028) | Original paragraph/style IR and observed native glyph reuse | Separate experiment; general reflow is not integrated |
| [Docling](https://github.com/Shinick-Han/docling) / [Heron](https://huggingface.co/docling-project/docling-layout-heron) | Optional semantic region proposals from page images | CPU experiment only; model labels do not establish ownership or reading order |
| [LayoutFlow](https://github.com/Shinick-Han/LayoutFlow) | Research reference for learned document boxes | Forked; no runtime integration or accuracy claim |

The Heron experiment pins model revision `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` and verifies checkpoint SHA-256 `00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c`. Code and model licenses are separate. The detector was run directly through Transformers, not through an installed Docling conversion pipeline.

## Output observations

`paper-layout-quality.mjs` reads the generated PDF's paint geometry. It records overlap, rectangular clipping and explicitly observed output relationships. Source positions and source subset font names cannot serve as generated-output evidence after repagination.

The overall quality score remains null. Detected issue penalties and coverage describe the checks actually performed. They do not certify visual naturalness. Ordered content comparison remains independent and must not be replaced with a bag of words to accommodate floating objects.

New automatic hyphenation is disabled to avoid adding unrecorded hard hyphens. Literal source hyphens remain literal. Font size follows the source; shrinking text to fit is not the default. Failed attempts leave the user's selected changes and previous generated file intact.

## Verification

The normal application test runner includes the academic-flow and output-layout tests. Actual pinned Typst tests require the existing `FALSIFY_TYPST_MODULES`, `FALSIFY_TYPST_WASM` and `FALSIFY_TYPST_FONT` resources. Private paper runs and rendered comparisons stay outside the repository.

The layout diagnostics are partial: arbitrary clipping, transparency, vector group ownership and general reading order still require additional evidence. Unobserved checks must remain unavailable.
