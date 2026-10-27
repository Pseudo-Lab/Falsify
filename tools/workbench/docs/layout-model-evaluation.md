# Layout model experiment — 2026-10-28

Heron can propose semantic regions to complement native PDF geometry. This experiment does not justify enabling it in the editor: it misclassified the article title, returned conflicting duplicate regions and supplies no reading order. Caption detection and improved final PDF layout were not evaluated.

## Reproduced run

The unchanged public [cold-shower paper](https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0161749&type=printable), SHA-256 `b41ec33c64b72da8b5c43156751998f6b2f64a3a934dab15a2e15b0894bd2ffb`, was processed on a private Daytona CPU sandbox. No private experiment paper was uploaded. This uses the Heron detector directly through Transformers, rather than the full Docling conversion pipeline.

| Resource | Pin |
| --- | --- |
| Model | `docling-project/docling-layout-heron` |
| Revision | `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` |
| Verified weights SHA-256 | `00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c` |
| Runtime | Python 3.14.4, Transformers 4.51.3, pypdfium2 4.30.1, Torch 2.10.0+cu128, NumPy 2.4.1; CPU, CUDA unavailable |
| Scope | First 2 pages; confidence threshold 0.6; top-left page-point boxes |

The detector returned 36 and 14 regions. In an exploratory sample of 11 title/heading anchors selected **after seeing the detections**, all 11 had a box with IoU≥0.5 and 10 had the expected label. The article title was labeled `Section-header` with confidence 0.919. The first page included the same email box labeled both `Text` and `Footnote`, plus nested metadata regions. This sample is neither exhaustive nor an independent accuracy benchmark.

The existing parser returned 65 and 55 text-line boxes. All 120 overlapped some model region by at least half their line area. This measures geometric coverage across different granularities; it does not measure semantic correctness, caption ownership or reading order. The inspected pages had no figure captions.

## Reproduce and interpret

`tools/layout-evaluation/bootstrap_minimal.py` creates a task-local environment, reusing system Torch. `docling_detector.py` verifies the public input and checkpoint hashes, runs inference and writes geometry/provenance plus public previews. `heading_sample.py` and `inventory_coverage.py` reproduce the limited measurements above. `compare.py` accepts a separate annotated gold set; its synthetic tests are not model accuracy evidence. Result files remain outside Git.

Run the tooling tests with:

```text
python -m unittest discover -s tools/layout-evaluation -p test_*.py -v
```

The initial full Docling package install exceeded the sandbox disk. The minimal detector environment succeeded. The official PDF URL reset its connection inside the sandbox, so the coordinator relayed the unchanged public PDF and verified its hash there. The owned sandbox was stopped after collection.

## Reuse decision

Keep native text and the existing deterministic inventory authoritative. Model boxes could later nominate paragraph/figure regions after source-glyph binding and conflict handling. Do not use confidence as proof or replace native text with OCR output. No inactive model adapter is added to the production application.

[Docling code](https://github.com/docling-project/docling/blob/v2.143.1/LICENSE) is MIT; the [Heron model card](https://huggingface.co/docling-project/docling-layout-heron) declares Apache-2.0 separately. [LayoutFlow](https://github.com/Shinick-Han/LayoutFlow), fork commit `8e0b8b697540c32bcfc10f21125c1dd3ce8df287`, is a box-proposal research reference. Its checkpoint metadata was inspected, but inference and download hashes were not verified. It is not a typography or content-preservation validator. No executable/checkpoint was verified for OmniDocLayout.
