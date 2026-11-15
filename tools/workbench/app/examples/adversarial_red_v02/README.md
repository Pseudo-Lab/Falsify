# Adversarial RED runner v0.2.0

Offline RED injector. It plans coordinated multi-surface bundles, then writes a blind PDF (and blind supplements) plus a sealed `falsify.red-gold-ledger.v1`. The source PDF and source supplements are never overwritten. Answer-key fields stay in the gold file.

Profile id: `shinick-adversarial-red-v02`.

The runner asks `plan_coordinated_mutations` in `app/local/paper_red_planner.py` for detectability-checked bundles before it falls back to single-operation candidates. L3 plans prefer prose together with a table cell and/or a supplement edit.

## CLI

```bash
python app/examples/adversarial_red_v02/runner.py \
  --pdf SOURCE.pdf \
  --out-pdf BLIND.pdf \
  --out-gold GOLD.json \
  --out-audit AUDIT.json \
  --supplement TABLE.csv --supplement NOTES.md \
  --out-supplement-dir BLIND_SUPP \
  --target-difficulty L3 \
  --max-ops 3 \
  --seed 7
```

`--target-difficulty` is `L1`, `L2`, `L3` (default), or `L4`. Selected operations must measure at least that tier (`L1 < L2 < L3 < L4`) via `simulate_red_detectability`.

`--out-supplement-dir` receives blind copies of mutated supplements. The source supplement files stay untouched. When a supplement is edited and this directory is omitted, the process exits `2`.

`--out-audit` writes the `falsify.red-runner-audit.v0.2` record. Stdout is `falsify.red-runner-output.v1` and also carries `blindPdfBase64`, `blindSupplements`, and `goldLedger`.

`--red-brief` and `--ops-hint` accept a JSON object/array or a path to one. `--ops-hint` replaces coordinated planning. Hint tokens are dropped before export.

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
  "supplementNames": ["Table_S1.csv"]
}
```

`supplementNames` are read from `./supplements/<name>` relative to the process working directory. Inline `pdfBase64` and `supplements` are also accepted. The process writes the requested files and prints `blindPdfBase64`, `blindSupplements`, and `goldLedger`.

`python app/examples/adversarial_red_v02/build_profile.py` prints the `falsify.harness.v1` profile (`role` `red`, id `shinick-adversarial-red-v02`). The profile tracks `app/local/paper_red_planner.py`.

## Difficulty

| Tier | Planned shape |
|---|---|
| L4 | Length-matched or layout-safe prose polarity/causal swap (`suggests` to `confirms`, `increased` to `decreased`, `lacks` to `shows`) with no Layer 0 detector |
| L3 | Prose numeric edit coordinated with a table cell and/or a supplement row, leaving another row or file as the cross-surface anchor |
| L2 | Table-cell edit that breaks row/column arithmetic |
| L1 | DOI link target swap on a link the source baseline does not already flag |

Pre-existing Layer 0 defects are not targeted.
