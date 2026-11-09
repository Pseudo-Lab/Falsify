# DropFusion-Edu

> **Educational fiction.** This repository is teaching material for research-safety-gate
> exercises. Every subject, specimen, feature and outcome is synthetic. No blood was drawn,
> no assay was run, no patient data were used, and nothing here describes clinical or
> diagnostic performance.

The fictional study asks whether protein-like and RNA-like features from one small sample can
be fused with attention to predict outcomes. What the code actually does is narrower: it
classifies six synthetic 180-day outcomes (`SYN_T01`-`SYN_T06`) from 119 synthetic features,
with a linear baseline and a small two-head attention model, evaluated on held-out synthetic
subjects.

## Layout

| Path | Contents |
| --- | --- |
| `task_contract.yaml` | scope of the exercise and its limits |
| `protocol/` | analysis plan, terminology and mask conventions |
| `configs/` | Hydra configuration (`config.yaml`, `data/synthetic.yaml`, `model/fusion.yaml`) |
| `schedule/cases.jsonl` | scheduled cases: case id and command-line overrides |
| `src/` | generator, labels, pairing, split, preprocessing, models, training, evaluation, pipeline |
| `tools/` | run launcher, contract checks, independent metric recomputation |
| `data/` | frozen synthetic cohort, dictionaries and masks |
| `examples/` | paired preview and small contract examples |
| `tests/` | unit and contract tests |
| `author/`, `authoring_steps/` | Korean draft and authoring handoff records |
| `evidence/` | reference registry |

## Environment

Python 3.13 on CPU, with the packages pinned in `environment.lock` (CPU build of PyTorch).
No network access, credentials or GPU are needed to run anything here.

## Reproducing

From the repository root:

```bash
python -m src.generate --out data          # regenerates the frozen cohort byte-for-byte
python -m pytest                           # unit and contract tests
python -m tools.verify_contracts           # data contracts
python -m tools.run_case --case <case_id>  # one scheduled case -> runs/<case_id>/
python -m tools.recompute_metrics --run <case_id>
python -m tools.verify_contracts --run <case_id>   # or --all-runs
```

`tools.run_case` refuses to start when tracked source files have uncommitted changes or when
`runs/<case_id>/` already exists. Each run directory holds the launch record, the source
archive and index, the Hydra configuration (`.hydra/`), fit membership and preprocessing
statistics, the checkpoint ledger and selected checkpoint, selection details, predictions,
the evaluation flow, metrics, an event log and a run manifest with output hashes.

## Archived execution source

To reproduce archived execution `run_m72s` from the same source, use a separate clean checkout at source_commit `f5ce7fe2e8399fcb2bc6b157e970b8fe2b70bf48`. Install the locked environment there and run:

```bash
git checkout --detach f5ce7fe2e8399fcb2bc6b157e970b8fe2b70bf48
python -m tools.run_case --case run_m72s
```
