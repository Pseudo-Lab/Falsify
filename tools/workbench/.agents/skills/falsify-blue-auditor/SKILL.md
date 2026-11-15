---
name: falsify-blue-auditor
description: Autonomous BLUE academic paper verification protocol using app/local/paper_mcp.py, app/local/falsify_cli.py blue scan --digest-only, anti-false-positive checks, strict quote-binding, and selective abstention (falsify.blue-report.v1).
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
