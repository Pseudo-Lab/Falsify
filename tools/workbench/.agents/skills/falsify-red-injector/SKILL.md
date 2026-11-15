---
name: falsify-red-injector
description: Autonomous RED adversarial test-generator protocol using app/local/paper_red_mcp.py, app/local/falsify_cli.py (red targets, red apply, blind verify), Baseline Guard, pre-export detectability, difficulty gate, stealth enforcement, and strict blind/gold separation.
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
- Print a client-ready stdio config with absolute paths and no file writes: `python app/local/falsify_cli.py mcp-config --pdf SOURCE.pdf [--workspace DIR] [--analysis] [--oracle] [--supplement SUPP ...]` (`falsify.mcp-config.v1`, `registers: [claude, codex, gemini]`).
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

## 5. Pre-export detectability and propagation

Before writing a blind PDF, score the plan with `simulate_red_detectability` and map a numeric or textual anchor with `trace_claim_propagation`. Both live in `app/local/paper_red_detectability.py`.

```bash
python app/local/falsify_cli.py red simulate --pdf SOURCE.pdf --ops OPS.json
python app/local/falsify_cli.py red trace --pdf SOURCE.pdf --query "0.94"
```

Distances are `L1 < L2 < L3 < L4`. `D3` and `S1` have no Layer 0 detector and land on `L4`. A supplement or other non-prose edit that fires no static signal lands on `L3`.

## 6. Difficulty gate

```bash
python app/local/falsify_cli.py red apply --pdf SOURCE.pdf --ops OPS.json --out-pdf BLIND.pdf --out-gold GOLD.json --min-difficulty L3
```

`--min-difficulty` is one of `L1`, `L2`, `L3`, `L4`. The command keeps an operation only when its cross-inference distance is at least that tier. If every operation is below the floor, the process exits `3` with `difficulty_below_minimum` and does not write the blind PDF.

## 7. RED plan

`plan_coordinated_mutation` on `app/local/paper_red_mcp.py` is the read-only RED plan step. It calls `plan_coordinated_mutations` in `app/local/paper_red_planner.py` (`falsify.red-mutation-plan.v1`) and returns detectability-checked bundles for `L1`..`L4`. Default target is `L3`. L3 bundles coordinate prose `text-span` edits with `table-cell` and/or `supplement-edit` and leave another surface as the anchor. The tool does not write a PDF.

## 8. Autonomous RED runner

`app/examples/adversarial_red_v02/runner.py` plans with `plan_coordinated_mutations` before it falls back to single-operation candidates. It writes the blind PDF, the gold ledger, optional `--out-audit`, and blind supplement copies under `--out-supplement-dir` without modifying the source files.

```bash
python app/examples/adversarial_red_v02/runner.py \
  --pdf SOURCE.pdf \
  --out-pdf BLIND.pdf \
  --out-gold GOLD.json \
  --out-audit AUDIT.json \
  --supplement TABLE.csv \
  --out-supplement-dir BLIND_SUPP \
  --target-difficulty L3
```

Stdin `falsify.red-invocation.v1` (the `arena_duel.py` contract) accepts `sourcePdf`, `outPdf`, `outGold`, `outSupplementsDir`, `minDifficulty`, and `supplementNames` loaded from `./supplements/<name>`. Stdout includes `blindPdfBase64`, `blindSupplements`, and `goldLedger`. `python app/examples/adversarial_red_v02/build_profile.py` prints the `falsify.harness.v1` profile `shinick-adversarial-red-v02`.

`app/examples/adversarial_red_v01/runner.py` runs baseline guard, surface discovery, a deterministic planner (optional `planner_fn`), detectability plus stealth retries, and the blind bundle with a sealed gold ledger.

```bash
python app/examples/adversarial_red_v01/runner.py --pdf SOURCE.pdf --out-pdf BLIND.pdf --out-gold GOLD.json --target-difficulty L3
```

Omit `--pdf` to read `falsify.harness-invocation.v1` or `falsify.red-invocation.v1` from stdin (`pdfPath` or `pdfBase64`, `outPdfPath`, `outGoldPath`, `targetDifficulty`, `redBrief`, `settings`). A missed difficulty or a failed stealth audit exits `3` (`difficulty_target_unmet`, `stealth_audit_failed`). The runner refuses to overwrite the source PDF. `python app/examples/adversarial_red_v01/build_profile.py` prints the `falsify.harness.v1` RED profile.
