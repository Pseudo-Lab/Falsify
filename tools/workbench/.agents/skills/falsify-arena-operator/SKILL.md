---
name: falsify-arena-operator
description: Operate unattended Falsify Arena evaluation and RED/BLUE co-evolution with run-round, score, distill, duel, apply-patch, evolve, and benchmark.
license: AGPL-3.0-only
---

# Falsify Arena Operator

Run Arena evaluation without opening answer keys in the BLUE context. Commands below are `python app/local/falsify_cli.py ...`. Wave 10 keeps the cleanroom gate, the scrubbed harness patch, and rollback on holdout or recall regression.

## 1. Cleanroom single-paper evaluation

`falsify arena run-round` is the single-paper cleanroom. `verify_blind_bundle` is the pre-gate: a bundle that fails blindness does not reach the agent. Pass the blind PDF, the agent command, optional supplements, and optional `--gold` only on the scoring side of the runner.

```bash
python app/local/falsify_cli.py arena run-round --pdf BLIND.pdf --agent-cmd BLUE_EXE --source-pdf SOURCE.pdf --supplement SUPP --runs 1 --out ROUND.json
```

`falsify arena score` compares BLUE reports with the sealed gold ledger. It reports Krippendorff's alpha (nominal and ordinal) and selective prediction (Risk-Coverage / `AURC`). `--baseline` is the previous score file when you need a comparison, not a second answer key.

```bash
python app/local/falsify_cli.py arena score --gold GOLD.json --blue BLUE1.json --blue BLUE2.json --baseline PREVIOUS.json --out SCORE.json
```

`blindness_leak_detected` is fatal (exit `3`). Stop the round; do not distill or promote from a leaked bundle.

## 2. Answer-key-free distillation and rule compaction

`falsify arena distill` turns a scored round into `falsify.harness-patch.v1`. The patch may carry aggregate counts and generalized rules only. If an answer-key pattern survives, distillation exits `3` with `distill_scrub_failed` and writes nothing.

`compact_harness_rules` then bounds that rule list (duplicates and over-broad rules dropped) before promotion. A patch that fails the scrub cannot be compacted into a promotable harness.

```bash
python app/local/falsify_cli.py arena distill --round ROUND.json --gold GOLD.json --max-rules 40 --out PATCH.json
```

## 3. Head-to-head duel and guarded promotion

`falsify arena duel` runs RED against BLUE on one source and any holdout PDFs. `falsify arena apply-patch` promotes a scrubbed patch onto a harness.

`MAX_GENERATIONS_CAP = 3`. A promotion that raises holdout false positives exits `3` with `holdout_fp_regression` and does not replace the harness.

```bash
python app/local/falsify_cli.py arena duel --source-pdf SOURCE.pdf --red-cmd RED_EXE --blue-cmd BLUE_EXE --holdout-pdf HOLDOUT.pdf --min-difficulty L3 --max-rules 40 --out DUEL.json
python app/local/falsify_cli.py arena apply-patch --harness HARNESS.json --patch PATCH.json --role blue --max-generations 3 --out PROMOTED.json
```

## 4. Multi-generation co-evolution

`falsify arena evolve --role blue|red|both` is the unattended loop. The lineage schema is `falsify.evolution-lineage.v1`.

- Generation 0 is the baseline benchmark. It is not a promotion.
- With `--role both`, later generations alternate: odd generations train BLUE, even generations train RED. A single `--role blue` or `--role red` keeps that side for every generation after the baseline.
- Each generation rolls back automatically when holdout false positives rise or benchmark recall regresses. The previous harness stays active.
- `blindness_leak_detected` aborts the campaign immediately (exit `3`). Do not continue to the next generation.
- The lineage `paretoFrontier` is the Pareto frontier of recall against holdout false positives (and `AURC` when present).

```bash
python app/local/falsify_cli.py arena evolve --source-pdf SOURCE.pdf --holdout-pdf HOLDOUT.pdf --role blue|red|both --red-cmd RED_EXE --blue-cmd BLUE_EXE --generations 3 --min-difficulty L3 --max-recall-drop 0.0 --out LINEAGE.json --out-harness HARNESS.json
```

`--generations` cannot exceed `MAX_GENERATIONS_CAP`.

## 5. Synthetic regression gate

`falsify arena benchmark` is the synthetic regression gate. Wave 10 uses the `v3` 24-case Gold + Benign-Trap Holdout corpus. Pass `--baseline` (benchmark CLI flag `--baseline-report`) to compare against a saved report. Recall drop or a holdout false-positive increase fails the gate; do not promote that harness.

```bash
python app/local/falsify_cli.py arena benchmark --mode sensor --baseline-report PREVIOUS.json --max-recall-drop 0.0 --out BENCH.json
```
