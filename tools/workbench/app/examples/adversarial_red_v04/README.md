# Adversarial RED runner v0.4.0

Offline RED injector. It plans coordinated multi-surface bundles, including native vector `chart-shape` edits, surgical `xlsx-cell` and `ipynb-cell` edits, and L4 semantic prose swaps, then writes a blind PDF (and blind supplements) plus a sealed `falsify.red-gold-ledger.v1`. The source PDF and source supplements are never overwritten. Answer-key fields stay in the gold file.

Profile id: `shinick-adversarial-red-v04`.

The runner asks `plan_coordinated_mutations` in `app/local/paper_red_planner.py` for detectability-checked bundles before it falls back to single-operation candidates. A `redBrief` (`preferredSurfaces` / `targetSurfaces`, `targetFamilies`, `targetWorlds`) boosts matching bundles. L3 plans prefer a 3-surface bundle (`figure` + `prose` + `table` or `supplement`) when that bundle stays stealth-clean, then a 2-surface bundle, then a single operation. Workbook and notebook supplements that share a metric join that bundle as `xlsx-cell` or `ipynb-cell`.

Visual operations diff figure-forensic signals (`duplicate_figure_panel`, `mirrored_figure_panel`, `rotated_figure_panel`, `cropped_figure_panel`, `chart_printed_value_mismatch`) against a fresh in-memory evidence store of the edited PDF. Text and table edits skip that pass. Workbook cells are rewritten inside the xlsx zip; notebook cells are rewritten in the ipynb JSON. Neither executes formulas, cells, or macros.

## CLI

```bash
python app/examples/adversarial_red_v04/runner.py \
  --pdf SOURCE.pdf \
  --out-pdf BLIND.pdf \
  --out-gold GOLD.json \
  --out-audit AUDIT.json \
  --supplement TABLE.csv --supplement COHORT.xlsx --supplement NOTES.ipynb \
  --out-supplement-dir BLIND_SUPP \
  --target-difficulty L3 \
  --red-brief "{\"preferredSurfaces\":[\"prose\",\"supplement\"],\"targetFamilies\":[\"D5\"]}" \
  --max-ops 3 \
  --seed 7
```

`--target-difficulty` is `L1`, `L2`, `L3` (default), or `L4`. Selected operations must measure at least that tier (`L1 < L2 < L3 < L4`) via `simulate_red_detectability`.

`--out-supplement-dir` receives blind copies of mutated text supplements, surgically edited `.xlsx` and `.ipynb` bytes, and byte-for-byte copies of untouched structured supplements. `.pdf` and `.docx` supplements stay binary passthrough. Text supplements (`.csv`, `.tsv`, `.md`, `.json`) use `supplement-edit`. The source supplement files stay untouched. When a supplement is edited and this directory is omitted, the process exits `2`.

`--out-audit` writes the `falsify.red-runner-audit.v0.4` record. Stdout is `falsify.red-runner-output.v1` and also carries `blindPdfBase64`, `blindSupplements`, and `goldLedger`.

`--red-brief` and `--ops-hint` accept a JSON object/array or a path to one. `--ops-hint` replaces coordinated planning. Hint tokens are dropped before export. A brief must not carry answer-key fields (`before`, `after`, `gold`, `goldLedger`, `defects`, `changes`).

Exit `2` covers a bad contract, a missing PDF, or a destination that is the source file. Exit `3` is `difficulty_target_unmet` or `stealth_audit_failed`. Stealth must not be `detectable_artifact`.

## Stdio

Omit `--pdf` and write one JSON object to stdin. `schema` may be `falsify.harness-invocation.v1` or `falsify.red-invocation.v1`.

`arena_duel.py` sends `falsify.red-invocation.v1`:

```json
{
  "schema": "falsify.red-invocation.v1",
  "sourcePdf": "source.pdf",
  "outPdf": "blind.pdf",
  "outGold": "gold.json",
  "outSupplementsDir": "blind_supplements",
  "minDifficulty": "L3",
  "supplementNames": ["Table_S1.csv"],
  "redBrief": {"preferredSurfaces": ["figure", "prose"], "targetFamilies": ["D4-1"]}
}
```

`supplementNames` are read from `./supplements/<name>` relative to the process working directory. Inline `pdfBase64` and `supplements` are also accepted. Harness `settings.redBrief` or instruction cues are used when `redBrief` is absent. The process writes the requested files and prints `blindPdfBase64`, `blindSupplements`, and `goldLedger`.

`python app/examples/adversarial_red_v04/build_profile.py` prints the `falsify.harness.v1` profile (`role` `red`, id `shinick-adversarial-red-v04`). The profile tracks `app/local/paper_red_planner.py` and `app/local/paper_supplement_mutator.py`.

## Difficulty

| Tier | Planned shape |
|---|---|
| L4 | Layout-safe prose polarity swap, or a semantic D3/S1/D5 swap (observational claim stated as causal, adverse wording stated as beneficial, secondary outcome stated as the primary endpoint) with no Layer 0 detector |
| L3 | Prose numeric edit coordinated with a table cell, a supplement row, an `xlsx-cell`, and/or an `ipynb-cell`, optionally with a native vector `chart-shape` (`W4`, `D4-1`), leaving another row or clause as the cross-surface anchor |
| L2 | Table-cell edit that breaks row/column arithmetic |
| L1 | DOI link target swap, or a figure-forensic hit such as a newly introduced duplicate panel |

Pre-existing Layer 0 defects, including a duplicate panel already on the source PDF, are not targeted.
