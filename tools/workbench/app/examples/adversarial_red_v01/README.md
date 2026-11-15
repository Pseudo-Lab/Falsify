# Adversarial RED runner v0.1.0

Offline RED injector. It writes a blind PDF (and blind supplements) plus a sealed `falsify.red-gold-ledger.v1`. The source PDF is never overwritten. Answer-key fields stay in the gold file.

Profile id: `shinick-adversarial-red-v01`.

## CLI

```bash
python app/examples/adversarial_red_v01/runner.py \
  --pdf SOURCE.pdf \
  --out-pdf BLIND.pdf \
  --out-gold GOLD.json \
  --supplement TABLE.csv --supplement NOTES.md \
  --out-supplement-dir BLIND_SUPP \
  --target-difficulty L3 \
  --max-ops 3 \
  --seed 7
```

`--target-difficulty` is `L1`, `L2`, `L3` (default), or `L4`. Selected operations must measure at least that tier (`L1 < L2 < L3 < L4`) via `simulate_red_detectability`. The built-in planner prefers the closest tier.

`--red-brief` and `--ops-hint` accept a JSON object/array or a path to one. A harness patch (`falsify.harness-patch.v1`) may be passed as `--red-brief`; mentioned families and surfaces are tried first. Hint tokens (`tampered`, `falsify`, `red-plan`, `answer-key`, `변조`, `정답`, and the other blindness tokens) are dropped.

`--ops-hint` replaces the built-in planner. If those operations cannot meet the tier, the process exits `3` with `difficulty_target_unmet`.

Exit `2` covers a bad contract, a missing PDF, or a destination that is the source file. Exit `3` is `difficulty_target_unmet` or `stealth_audit_failed`. Stealth must not be `detectable_artifact`.

When a supplement is edited, `--out-supplement-dir` is required. Those files are the mutated text only.

## Stdio

Omit `--pdf` and write one JSON object to stdin. `schema` may be `falsify.harness-invocation.v1` or `falsify.red-invocation.v1`.

```json
{
  "schema": "falsify.harness-invocation.v1",
  "pdfPath": "SOURCE.pdf",
  "outPdfPath": "BLIND.pdf",
  "outGoldPath": "GOLD.json",
  "targetDifficulty": "L4",
  "settings": {"bundleSha256": "<from contract_settings()>"}
}
```

`pdfBase64` may replace `pdfPath`. When `settings` contains `bundleSha256`, it must match `contract_settings()`.

`python app/examples/adversarial_red_v01/build_profile.py` prints the `falsify.harness.v1` profile (`role` `red`, id `shinick-adversarial-red-v01`).

## Difficulty

| Tier | Built-in shape |
|---|---|
| L4 | Prose qualifier or causal-verb edit (`D3` or `S1`) with no Layer 0 detector |
| L3 | Supplement numeric edit that does not create a same-surface sum break |
| L2 | Table-cell edit that breaks row/column arithmetic |
| L1 | DOI link target swap on a link the source baseline does not already flag |

Pre-existing Layer 0 defects are not targeted. A link or table cell already named by the baseline sensor is removed before export.

## Blindness

`BLIND.pdf` and files under `--out-supplement-dir` do not carry `before`, `after`, `gold`, `rationale`, or hint tokens. `GOLD.json` holds `operations`, `changes`, `defects` (`world`, `family`, `difficulty`, `surface`, `stealthPass`), `detectabilitySummary`, and `stealthAudit`.
