---
name: falsify-blue-auditor
description: Autonomous BLUE academic paper verification protocol using app/local/paper_mcp.py, app/local/falsify_cli.py blue scan --digest-only, the blue validate report gate (verbatim quote check + Zero-Drop restoration + 12-column CSV), anti-false-positive checks, strict quote-binding, and selective abstention (falsify.blue-report.v1).
license: AGPL-3.0-only
---

# Falsify BLUE Auditor

Run an independent, strictly blind scientific-integrity audit on a candidate PDF and optional supplementary files. Never inspect RED plans, gold ledgers, `before`/`after`/`patch`/`gold` keys, or unblinded answer keys.

## 1. Deterministic Layer 0 + Supplement Triage

Start with deterministic triage before spending model budget on full-page rereads:

```bash
python app/local/falsify_cli.py blue scan --pdf CANDIDATE.pdf [--supplement SUPP ...] [--oracle] --digest-only
```

- Invokes `app/local/paper_blue_sensor.py` (`run_blue_sensor` with `include_external_oracle` when `--oracle` is enabled) and `app/local/paper_supplement_audit.py` (`audit_paper_with_supplements`) across `.csv`, `.tsv`, `.json`, `.md`, `.txt`, `.log`, `.py`, `.r`, `.sql`, `.pdf`, and `.docx` supplements.
- Read-only MCP tools `audit_figures` (placed-panel and chart-claim forensics) and `recompute_raw_supplement` (row-level CSV/TSV/JSON recomputation of N, mean/SD, median/IQR, and unadjusted two-group p) sit on `app/local/paper_mcp.py`. Adjusted, multivariable, and multiplicity-corrected p-values are not raw-data defects.
- Portable bundle `app/examples/evidence_blue_v038/` (`shinick-blue-evidence-triage-v038`) extends v0.3.7. It records `rawDatasetAudit` / `rawDatasetSignals` and a post-model quote plus Zero-Drop gate in `audit['reportValidation']`: at most one quote-repair turn, then any still-ungrounded `defect`/`아님` quote is downgraded to `확인필요`.
- `app/local/paper_code_audit.py` `audit_code_supplements(page_items, supplements, max_signals=30)` statically compares `.py` (AST), `.R`, and `.sql` supplements with manuscript sentences. It never executes supplement code. Signals are family `D6` and set `excerpt`/`pageIndex` from the matched sentence, plus `supplementName`, `lineNumber`, and `codeSnippet` (`supplementName` is repeated inside `computed`). `paper_mcp_bundle.audit_code_supplements_payload` binds the PDF and, when `supplement_id` selects a script, keeps `.csv`/`.tsv` companions.
- `run_blue_sensor_payload(..., include_flow_triage=)` accepts `includeFlowTriage` only as a bool. It forwards `include_flow_triage` when `paper_blue_sensor.run_blue_sensor` already has that parameter, and the digest copies `flowAndSpinTriage` when the sensor returns it.
- Portable bundle `app/examples/evidence_blue_v039/` (`shinick-blue-evidence-triage-v039`) extends v0.3.8 without editing v0.3.1–v0.3.8. `triage_workspace` is `.local/blue-evidence-v039-audits` (`execute(..., audit_dir=)` overrides it). `deterministicTriage.codeAudit` records `audit_code_supplements`. When `paper_flow_and_spin_triage` is importable, the same workspace also stores `flowAndSpinTriage` (`flowSignals`, `spinTriageHints`). The quote gate folds ligatures, dashes, curly quotes, `µ`/`μ`, and line-wrap hyphens to `normalized` before the one repair turn and Zero-Drop downgrade.
- Rejects any JSON supplement containing forbidden RED keys (`before`, `after`, `patch`, `gold`, `why_hard`, `candidateRationales`, `plan`) with exit code `3`.
- `--digest-only` strips bulky raw link/widget lists and caps excerpts (< 12 KB) so triage fits cleanly in an agent context window.
- When running interactively over stdio MCP, launch `app/local/paper_mcp.py`:
  ```bash
  python app/local/paper_mcp.py --pdf CANDIDATE.pdf --analysis
  ```
  and call `status`, `list_items`, `audit_statistics`, and `list_references`.

## 2. Targeted Reread (Budgeted)

Inspect ONLY flagged claims, mismatched cross-file anchors, or high-risk quantitative/visual claims using `app/local/paper_mcp.py`:

- **Prose & Claims**: `read_page_text` and `search_text` to verify exact wording, sample sizes, denominators, and statistical test parameters.
- **Tables**: `list_items` followed by `read_item` for raw cell text; confirm with `render_region` when merged headers, superscripts, or OCR ambiguity exist.
- **Figures & Charts**: `render_region` first to visually inspect axes, ticks, legends, and curves; use `extract_chart` (and `digitize_points` with explicit pixel calibration from the exact `imageSha256`) only when curve/bar geometry needs numerical verification.

## 3. Anti-False-Positive Verification Checklist

Before emitting a committed `defect`, verify every candidate against these common benign patterns:

1. **Multivariable `aOR` / `aRR` / `aHR` vs Crude `2x2` Counts**: Adjusted odds/risk/hazard ratios from regression models legitimately differ from crude ratios computed directly from raw `2x2` table cell counts. Flag a discrepancy only when the paper explicitly claims an unadjusted/crude ratio or when covariate counts/denominators contradict the table.
2. **Multiple-Testing Corrections (`p_adj`, `FDR`, `Bonferroni`, `Holm`)**: Do not flag adjusted `p`-values as `GRIM`/`statcheck` mismatches against nominal test statistics (`t`, `F`, `chi2`, `z`) when the text or table header indicates `p_adj`, `FDR`, `q-value`, or family-wise correction.
3. **Delayed-Entry / Left-Truncated Kaplan-Meier (`KM`) Curves**: In left-truncated or landmark survival analyses, the number at risk can increase at early time intervals or start below total enrolled `N`; verify entry/censoring rules in Methods before calling a risk-table mismatch.
4. **Embargoed / Private Registries (`PROSPERO`, `OSF`)**: HTTP `404` or access-restricted status on `PROSPERO` or `OSF` does **not** prove fabrication (`404 != fabrication`). Classify unresolved/embargoed registries as `needs_check`, never as a fabricated defect without positive contradicting metadata.

## 4. Strict Quote-Binding & `falsify.blue-report.v1` Output

Every reported finding must bind to verbatim evidence observed in the blind bundle (`quote`/`excerpt`, `pageIndex`, and `itemId` when referencing a table or figure). Optimize selective prediction (`AURC` via `tools/evaluation/agreement_selective.py`) using two active finding verdicts:

- `"defect"`: Committed defect verified with exact quote/cell/pixel/arithmetic contradiction.
- `"needs_check"`: Selective abstention when evidence is ambiguous, cropped, embargoed, or requires raw data access.

Emit `falsify.blue-report.v1` JSON:

```json
{
  "schema": "falsify.blue-report.v1",
  "paperId": "...",
  "fileHash": "...",
  "findings": [
    {
      "id": "b1",
      "verdict": "defect",
      "family": "D1",
      "pageIndex": 0,
      "itemId": "t1",
      "quote": "exact verbatim text or cell value",
      "rationale": "concise arithmetic or cross-modal contradiction",
      "confidence": 0.95
    }
  ]
}
```

## 5. Report Gate: `blue validate` (Hallucination Block + Zero-Drop)

Before handing a `falsify.blue-report.v1` file to the arena, gate it against the blind PDF. Every quote is re-located in the PDF text and every stage-1 candidate must survive into stage 2:

```bash
python app/local/falsify_cli.py blue validate --pdf BLIND.pdf --report BLUE_REPORT.json \
  [--ledger CANDIDATES.json] [--csv BLUE_12COL.csv] [--out VALIDATION.json]
```

- Implemented by `app/local/blue_report_validate.py` (`validate_blue_report`); the CLI only wraps it in the JSON envelope. The command is read-only: it never modifies `BLIND.pdf` or `BLUE_REPORT.json`, and `--out`/`--csv` refuse any path that resolves to `--pdf`, `--report`, or `--ledger` (`cannot_overwrite_input`).
- **Quote gate**: each `quote`/`excerpt`/`resolutionQuote` is searched in `read_page_text`-equivalent line extraction of every page (whitespace collapsed, soft-hyphen line joins repaired). Result per quote: `exact` (case-sensitive verbatim), `normalized` (found only after an extra case-insensitive pass) or `missing`. A missing quote returns `nearestCandidates` (max 5 `_line_similarity`-ranked `{pageIndex, bbox, text}` lines) plus a `recoveryHint`. When a finding declares `pageIndex`/`page`, its quote is searched only inside that page.
- **Zero-Drop restoration**: `--ledger` (or `report.candidateLedger`) entries are matched to findings by candidate id, then by a >= 12-character normalized quote overlap, then by same page + `locationLabel` containment. Unmatched candidates are restored as `{verdictLabel: "확인필요", zeroDropRecovered: true, severity: "불일치", confidence: "확인필요 (Zero-Drop 복원)"}`; a `맞음` verdict without `resolutionQuote` or a non-empty `rationale` is downgraded the same way. The semantics are a faithful port of `reconcileCandidateLedger`/`partitionStage2` in `app/dist/blue-defect-sensor-core.js` (never imported) and mirror `app/tests/blue-defect-sensor.spec.cjs`.
- **`zeroDrop.summary`** always carries exactly `stage1Count`, `resolvedOkCount`, `reportedDefectCount`, `recoveredCount`.
- **`--csv`** writes the score.py-compatible 12-column BLUE rows (`paper_id, team, judge_type, model, iteration, location, defect_type, label, evidence, time_sec, tokens, is_holdout`) that `tools/evaluation/agreement_selective.py` reads. `label` maps to `아님|맞음|확인필요`, `defect_type` is whitelisted to `D1..D7`, `D4-1`, `S1` (`D3` fallback is recorded in `warnings`), text cells starting with `= + - @` get a leading `'`, encoding is UTF-8 without BOM, quoting is RFC 4180.
- **Exit codes**: `0` all quotes located after restoration; `3` any `missing` quote remains, or the report/ledger carries forbidden RED keys (`before`, `after`, `patch`, `gold`, `why_hard`, `candidateRationales`, `plan`); `2` malformed input (bad JSON, unknown `verdictLabel`, non-object finding, `> 5000` findings, unreadable PDF); `124` timeout. Every failure keeps the `{"schema":"falsify.agent-cli.v1","ok":false,"error","message","recoveryHint"}` envelope; success returns `ok` plus `paperId`, `fileHash`, `quoteCheck`, `zeroDrop`, `csv`, `warnings`.

## 6. Wave 10 supplements, internal consistency, and `blue finalize`

`app/local/blue_report_validate.py` checks these supplements with the stdlib only (`zipfile`, `xml.etree`, `json`). XML `<!DOCTYPE` / `<!ENTITY` and entries larger than 25 MiB are rejected.

- **`.xlsx`** (bytes or `path`): multi-sheet workbooks. `xl/sharedStrings.xml`, `xl/workbook.xml`, and `xl/worksheets/sheet*.xml` become `[Sheet: <sheetName>]` plus tab-separated cell lines (`supplementName`, 1-based `lineNumber`). A formula cell keeps the static `<f>` text (with a leading `=`) and the cached `<v>` value side by side, so a quote can match either and the `<f>` vs `<v>` pair can be compared without executing the workbook.
- **`.ipynb`** (bytes or text): markdown cells, code `source`, and plain-text outputs (`stream`, `text/plain`, error text). `_guard_supplement_leaks` parses the notebook JSON, including metadata, and rejects forbidden RED keys (exit `3`).
- **`.Rmd` / `.qmd`**: UTF-8 text lines, the same treatment as `.py`, `.r`, and `.md`.

`audit_internal_consistency` (`python app/local/falsify_cli.py blue scan --internal-consistency`) keeps deterministic IMRaD `signals` separate from advisory `triageHints`. A triage hint is not a `defect` until a verbatim quote supports it.

Portable bundle `app/examples/evidence_blue_v040/` (`evidence_blue_v040`) is the Wave 10 evidence profile: the v0.3.9 quote gate plus workbook, notebook, R Markdown / Quarto, and internal-consistency surfaces.

Close a report in two turns so a hallucinated quote cannot remain a committed defect:

```bash
python app/local/falsify_cli.py blue validate --pdf BLIND.pdf --report BLUE_REPORT.json --emit-repair-pack
# optional one repair turn: paste a verbatim substring into quote, or set verdictLabel to 확인필요
python app/local/falsify_cli.py blue finalize --pdf BLIND.pdf --report BLUE_REPORT.json --out FINAL.json --csv BLUE_12COL.csv
```

`blue finalize` calls `finalize_blue_report` (`falsify.blue-report-finalize.v1`). It applies the repair list or finding-id map, restores Zero-Drop candidates, and moves every quote that is still `missing` into `unverifiedQuote` with `autoDowngraded`, `verdictLabel` `확인필요`, and the rationale prefix `[인용 미검증 자동 강등] `. A hallucinated `맞음` in `resolvedOk` is moved back into active `findings`. The embedded `finalizedReport` is gate-clean `falsify.blue-report.v1`: `validate_blue_report` returns `ok` and `quoteCheck.missingCount == 0`. `--csv` remains the 12-column RFC 4180 score file.

## 7. Wave 11 meta-analysis, PDF security, caching, SARIF 2.1.0, and `blue ensemble`

- **PRISMA & Meta-analysis + Cross-table `N` (`--meta-tables` / MCP `audit_meta_and_tables`)**: `app/local/paper_meta_and_table_audit.py` deterministically audits PRISMA screening arithmetic (`prisma_flow_mismatch`), forest-plot study weights (`meta_weight_sum_mismatch`), Cochran's $Q$/$I^2$ heterogeneity (`meta_heterogeneity_mismatch`), inverse-variance pooled estimates (`meta_pooled_effect_mismatch`), and cross-table arm denominators (`cross_table_sample_size_mismatch`, exempting explicit per-protocol/completer subsets).
- **PDF Stealth Security & Sub-panel/Axis Forensics (`--pdf-security` / MCP `audit_pdf_security`, `evidence_blue_v041`)**: `app/local/paper_pdf_security_forensics.py` detects micro-font/white-on-white/`3 Tr` hidden text (`hidden_pdf_text_layer`, exempting full-page scanned OCR overlays) and agent prompt-injection directives (`prompt_injection_directive`), while `paper_figure_forensics.py` adds intra-figure gutter-split sub-panel reuse (`composite_subpanel_duplicate`) and non-monotonic/truncated bar axes (`axis_scale_distortion`).
- **Content-addressed cache, SARIF 2.1.0 & Ensemble Consensus**: Pass `--cache-dir DIR` on `blue scan` / `blue scan-workspace`, export OASIS SARIF 2.1.0 via `--sarif OUT.sarif`, inspect schemas via `falsify schemas`, and merge heterogeneous blind BLUE reports via `falsify blue ensemble --report B1.json --report B2.json [--pdf BLIND.pdf]` (`falsify.blue-ensemble.v1`, preserving minority defect flags as `확인필요`).
