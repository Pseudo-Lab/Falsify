---
name: falsify-red-injector
description: Autonomous RED adversarial test-generator protocol using app/local/paper_red_mcp.py, app/local/falsify_cli.py (red targets, red apply, blind verify), Baseline Guard, stealth enforcement, and strict blind/gold separation.
license: AGPL-3.0-only
---

# Falsify RED Injector

Generate realistic, stealth-clean adversarial defects on a source PDF without ever mutating the original source file or leaking RED metadata into the blind output bundle.

## 1. Run Baseline Guard (`scan_source_baseline`) First

Always inspect the untouched source PDF before designing any mutation so injected defects do not collide with pre-existing author errors or broken baseline links:

```bash
python app/local/falsify_cli.py red targets --pdf SOURCE.pdf --include-baseline
```

- Enumerates addressable paragraphs, tables (`itemId`, rows/columns/cells), scientific figures, and `/URI` hyperlinks (`list_pdf_uri_links` from `app/local/paper_uri_mutator.py`).
- Runs offline Layer 0 `run_blue_sensor` (`Baseline Guard`) from `app/local/paper_blue_sensor.py`.
- When operating via stdio MCP (`app/local/paper_red_mcp.py --pdf SOURCE.pdf`), call `scan_source_baseline`, `list_red_targets`, and `list_pdf_links`.
- Skip any sentence, table cell, reference index, or link already flagged in `baseline.signals`.

## 2. Design Coordinated W1–W5 (`D1–D7`, `L1–L4`) Defects

Coordinate mutations across document modalities rather than making isolated single-token edits:

- **Prose (`text-span`)**: Subtle numerical, statistical, or claim-reversal edits in prose (delegates dynamically to `paper_text_span_mutator.mutate_pdf_text_spans` when installed).
- **Tables (`table-cell`)**: Modify table cells (`itemId`, `row`, `column`, `before`, `after`) via `app/local/paper_visual_edit.py` (`export_visual`) to create cross-text or internal-sum inconsistencies (`D1`).
- **Charts (`chart-shape` / `region-replace`)**: Prepare scenes with `app/local/paper_chart_edit_service.py` (`prepare_chart_scene`) or replace figure regions (`region-replace`) to introduce plotted curve/bar mismatches against reported prose/table numbers.
- **Hyperlinks (`uri-link`)**: Mutate `/Link` -> `/A` -> `/S /URI` annotations losslessly via `app/local/paper_uri_mutator.py` to inject `D2` visible-DOI vs target-URI mismatches or shared-target link hijacks across bibliography entries.
- **Supplements (`supplement-edit`)**: Introduce coordinated cross-file `N` or metric contradictions across attached `.csv`/`.tsv`/`.md`/`.log` supplements without adding any forbidden RED keys (`before`, `after`, `patch`, `gold`, `why_hard`, `candidateRationales`, `plan`) or hint phrases.

Map each operation cleanly across Waves `W1`–`W5`, defect families `D1`–`D7`, and stealth/difficulty tiers `L1`–`L4`.

## 3. Preview & Enforce Clean Stealth (`requireCleanStealth=True`)

- When using `app/local/paper_red_mcp.py`, call `preview_coordinated_edits` to visually inspect rendered PNG previews and check `stealthAudit`.
- Export the blind PDF and sealed gold ledger using `app/local/falsify_cli.py`:
  ```bash
  python app/local/falsify_cli.py red apply \
    --pdf SOURCE.pdf \
    --ops OPS.json \
    --out-pdf BLIND.pdf \
    --out-gold GOLD_LEDGER.json \
    --require-clean-stealth
  ```
- `--require-clean-stealth` invokes `app/local/paper_stealth_audit.py` (`audit_pdf_stealth`) and refuses to write `BLIND.pdf` (exit `3`) if `status == "detectable_artifact"`.
- Verify `changedPixels == 0` outside modified bounding boxes (`unmodifiedPagesIdentical: true`, `exteriorPixelsPreserved: true`, `pageCountPreserved: true`, `metadataClean: true`, `blindnessClean: true`).
- `red apply` refuses to overwrite `SOURCE.pdf` (exit `2`).

## 4. Verify Blindness & Isolate Artifacts

Before handing any bundle to BLUE or the evaluation runner, run:

```bash
python app/local/falsify_cli.py blind verify --pdf BLIND.pdf --source-pdf SOURCE.pdf [--supplement SUPP ...]
```

- Confirm exit code `0` (`"clean": true`, `"leaks": []`) across PDF metadata, XMP, pikepdf `DocInfo`, `/URI` annotations, visible text, and all attached supplements.
- Keep `BLIND.pdf` (plus blind supplements) strictly separated from `GOLD_LEDGER.json` (`falsify.red-gold-ledger.v1`) so BLUE never sees `GOLD_LEDGER.json` or operation rationales.
- Score completed BLUE runs against `GOLD_LEDGER.json` using `python app/local/falsify_cli.py arena score --gold GOLD_LEDGER.json --blue BLUE1.json --blue BLUE2.json` (`tools/evaluation/agreement_selective.py`).
