# Docling structure adapter (experimental)

`app/local/paper_structure.py` maps a [Docling](https://github.com/docling-project/docling) structured-document payload
onto the immutable source PDF as a private, versioned envelope of text, caption, table and picture regions. It is
read-only and on demand: nothing in export, QA or the UI calls it, the default editor is unchanged, and nothing in it
edits, renders or writes a PDF. Docling is not an app dependency; only PyMuPDF (already installed) is used to read the
source page geometry.

## Entry points

- `normalize_docling(payload, source_bytes, *, payload_origin='supplied')` — pure normalization. `payload` is a
  DoclingDocument as `dict` (`export_to_dict()`, JSON or Python mode) or JSON `str`/`bytes`. Never raises for bad input.
- `summarize(envelope)` — fixed public summary `{schema: 'falsify.pdf-structure-summary.v1', status, reason, items,
  resolvedItems}`; no refs, coordinates or text. `reason` is `null` or one of the fixed codes in `REASONS` (every
  envelope-level code this module emits); an envelope with any other reason (free text, list, dict, ...) or without
  `authority: 'structure-hint'` summarizes as `unavailable/envelope_invalid`, so no caller or document text is echoed.
- `convert_isolated(source_path, source_sha256, *, python, artifacts_path, runner=None)` — optional real conversion, see
  below. Without an explicit Docling interpreter and a local artifacts directory it returns
  `unavailable/conversion_unconfigured`.

## Envelope (`falsify.pdf-structure.v1`, private)

```
{schema, sourceSha256, payloadSha256, payloadOrigin: supplied|local-conversion,
 producer: {name: 'docling', schemaName: 'DoclingDocument', version}, authority: 'structure-hint',
 status: available|partial|unavailable, reason, checks: {originHash: matched|absent, pageGeometry: matched|unchecked},
 pages: [{pageIndex, pageNo, width, height, supportedGeometry}],
 items: [{ref, type: text|caption|table|picture, label, readOrder, status: resolved|unavailable, reason,
          regions: [{pageIndex, bbox: [x0, y0, x1, y1], charspan: [a, b]}], captionRefs}]}
```

- `bbox` is in MuPDF points of the unrotated, uncropped **source** page, top-left origin (the frame of
  `paper_inventory`). `pageIndex` is 0-based; Docling's `page_no` is 1-based and must be a real `int` (not `bool`).
- Docling `coord_origin` is converted explicitly: `TOPLEFT` keeps `t`/`b`; `BOTTOMLEFT` uses `H - t`, `H - b` with the
  Docling page height `H` (as `BoundingBox.to_top_left_origin`). A missing origin is refused, not defaulted.
- `type`/`label` keep the Docling collection and `DocItemLabel`; `readOrder` is the preorder index from `body` (then
  `furniture`) through groups, `null` for unreachable items; `captionRefs` keep table/picture caption refs (which must
  resolve to `texts`); `charspan` is copied from provenance. Item text, `orig`, table cells, images and annotations are
  never copied. No confidence is emitted and nothing is called editable.
- `status`: `available` when every item resolved, `partial` when some did, `unavailable` otherwise or when the payload
  was refused (`reason` is then a fixed code).

## Geometry and refusals

Source page boxes, rotation and crop are read independently from the source bytes. Docling reports boxes in the
rotated display frame of the visible (crop) box (`docling/backend/pypdfium2_backend.py`), so mapping is only
unambiguous on identity pages: rotation 0, MediaBox at the origin and CropBox equal to it (the same rule as
`paper_inventory._page_supported`).

| Situation | Result |
| --- | --- |
| unreadable, encrypted or oversized source, PyMuPDF missing | envelope `unavailable/source_unreadable` |
| not `DoclingDocument` 1.x | `schema_unsupported` |
| JSON with NaN/Infinity/overflowing floats, non-object, Python object cycle | `payload_invalid` |
| `origin.binary_hash` present but not the low 64 bits of the source SHA-256 (int or hex digest), non-PDF mimetype | `origin_hash_mismatch` / `payload_invalid` |
| more Docling pages than source pages, provenance on a page past the source | `page_count_mismatch` |
| identity page whose Docling size differs from the source by more than 0.5 pt (including swapped width/height) | `page_geometry_mismatch` |
| malformed `$ref`, dangling ref, wrong `self_ref`, caption ref to a non-text | `ref_invalid` |
| a node reached twice (cycle or shared child) | `ref_cycle` |
| items, tree nodes, provenance per item, captions or payload bytes over `LIMITS` | `over_budget` |
| rotated or cropped source page | item `unavailable/page_geometry` (page `supportedGeometry: false`) |
| provenance on a page missing from Docling `pages` | item `page_missing` |
| missing/non-finite/bool bbox values, missing or unknown `coord_origin`, inverted or empty box, box past the page (+1 pt) | item `bbox` |
| bool or float `page_no`, bad `charspan` | item `provenance` |
| no provenance | item `no_provenance` |
| unknown label, or a label that contradicts its collection (a `table` label among texts) | item `label` |

An item with several provenance entries (a table continued on the next page) gets one region per entry; if any entry
fails, the whole item is `unavailable` rather than partially mapped.

## Authority

`sourceSha256` binds the envelope to the bytes it was normalized against. It is not proof that the payload came from
those bytes: page sizes and `origin.binary_hash` (Docling writes `sha256` of the input, parsed by docling-core as the
low 64 bits) are consistency checks that a forged or stale payload can also pass, and `origin` may be absent. Every
envelope, including one from `convert_isolated`, therefore has `authority: 'structure-hint'`: regions may guide review or
QA but never authorize an edit, widen an edit region or override the source-derived edit plan (`paper_inventory`).
`payloadOrigin` records only who ran Docling, not trust.

## Optional conversion

`convert_isolated` hashes the source file, then runs `python -I paper_structure.py --docling-worker` with the caller's
interpreter (a separate venv that already has Docling; never this app's), a minimal environment forced offline
(`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, telemetry off, no tokens passed), fixed argv, no shell and a 600 s
timeout. The worker re-hashes the bytes, converts exactly those bytes as a `DocumentStream` with
`PdfPipelineOptions(artifacts_path=..., do_ocr=False, enable_remote_services=False, allow_external_plugins=False)` and
prints `export_to_dict()` as one JSON line. The parent normalizes it against the bytes it hashed itself. Nonzero exit,
timeout, empty, multi-line or oversized output is `conversion_failed`. Models are never downloaded: the caller must
point `artifacts_path` at models fetched beforehand (`docling-tools models download`), a separate, explicit step.

## Verified upstream (2026-10-12)

- docling-core `0d5a7bdc6eec6138055714756277730f1520ca61` (release v2.101.1, schema `CURRENT_VERSION = "1.10.0"`):
  `docling_core/types/doc/base.py` (`CoordOrigin`, `BoundingBox.to_top_left_origin`), `common/reference.py`
  (`RefItem` alias `$ref`, `ProvenanceItem`, `PageItem`), `common/origin.py` (`binary_hash` hex parsing),
  `items/node.py` (`DocItem.prov`, `FloatingItem.captions`), `labels.py` (`DocItemLabel`).
- docling `dd477a9f5feb3c505caeb6e73931bf93cecc79f4` (release v2.138.0): `document_converter.py` (`convert`,
  `PdfFormatOption`), `datamodel/pipeline_options.py` (`artifacts_path`, `enable_remote_services`,
  `allow_external_plugins`, `do_ocr`), `utils/utils.py` (`create_file_hash` is SHA-256),
  `pipeline/native_pdf_pipeline.py` (`binary_hash=document_hash`), `backend/pypdfium2_backend.py` (display frame).
- No code was copied from either repository; field names and the coordinate conversion follow their public schema.

## Tests

`app/tests/test_paper_structure.py` uses real in-memory PDFs (PyMuPDF) and DoclingDocument-shaped dicts. In an
environment with docling-core installed, `DoclingCoreTests` build payloads with the real docling-core API
(`add_page`, `add_text`, `add_table`, `add_picture`, `export_to_dict`, `model_dump_json`) and fixtures are checked with
`DoclingDocument.model_validate`; elsewhere those tests skip. Conversion tests use an injected runner plus one real
child process of an interpreter without Docling (expected `conversion_failed`). No Docling ML conversion is run.

## Licenses

- docling and docling-core code: MIT (`LICENSE` in both repositories).
- Models are licensed separately on Hugging Face: `docling-project/docling-layout-heron` Apache-2.0;
  `docling-project/docling-models` (TableFormer and the older layout model) tagged CDLA-Permissive-2.0 and Apache-2.0.
  Docling's conversion stack also pulls PyTorch, torchvision and docling-ibm-models (with their own licenses) and
  multi-GB model and wheel downloads; check each before bundling.
- PyMuPDF remains AGPL/commercial (see `app/local/requirements.txt`).

## Limits

- Rotated or cropped pages are never mapped, even where a backend's frame could be inferred.
- Region accuracy is Docling's layout prediction; the adapter checks only shape, finiteness and page bounds, not that a
  box covers the right content.
- Hand-built or stale payloads with correct page sizes and no `origin` normalize as `available`; only the authority
  rule above keeps them from being trusted.
- Real conversion is untested here: no Docling models were available locally and none were downloaded.
- Docling output is held in memory (up to 64 MiB of stdout) before the size check.
