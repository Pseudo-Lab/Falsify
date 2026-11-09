"""End-to-end run: pair, split, fit preprocessing, train, select, predict, evaluate.

Launched through Hydra so the composed configuration is stored in
``<run dir>/.hydra``. Normally started by ``python -m tools.run_case``, which
also records the launch and the source snapshot.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import hydra
import numpy as np
import pandas as pd
import torch
from hydra.core.hydra_config import HydraConfig
from hydra.experimental.callback import Callback
from omegaconf import DictConfig, OmegaConf

from src import evaluate, pairing, prepare, report, schema, split, train
from src.io_utils import read_csv, read_json, sha256_bytes, sha256_file, write_csv, write_json, write_jsonl
from src.model import build_model
from src.schema import TASK_IDS

log = logging.getLogger(__name__)

DATA_FILES = ["subjects.csv", "specimens.csv", "modality_crosswalk.csv", "protein.csv", "rna.csv", "labels.csv",
              "observation_mask.csv", "modality_mask.csv", "feature_dictionary.json", "label_dictionary.json",
              "label_provenance.json", "generation_manifest.json"]

# settings that have exactly one implementation; any other value stops the run
IMPLEMENTED = {
    "preprocess.imputer": "median",
    "preprocess.scaler": "standard",
    "model.optimizer": "adam",
    "data.missing_modality.one": "masked_token",
    "data.missing_modality.both": "abstain",
    "data.horizon_days": 180,
    "selection.checkpoint_split": "val",
    "evaluation.unit": "subject_id",
    "evaluation.averaging": "macro",
    "evaluation.bootstrap_unit": "subject_id",
}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class EventLog:
    """Append-only event log; each event is written and flushed when it happens."""

    def __init__(self, path: Path):
        self.path = path
        self.fh = open(path, "a", encoding="utf-8", newline="\n")
        self.seq = 0

    def add(self, event, **fields):
        self.seq += 1
        rec = {"seq": self.seq, "time": _now(), "event": event}
        rec.update(fields)
        self.fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.fh.flush()
        log.info("%s %s", event, {k: v for k, v in fields.items() if not isinstance(v, (list, dict))})

    def close(self):
        self.fh.close()


def check_implemented(cfg: DictConfig) -> None:
    for key, value in IMPLEMENTED.items():
        if OmegaConf.select(cfg, key) != value:
            raise ValueError(f"{key}={OmegaConf.select(cfg, key)!r} is not implemented (only {value!r})")


def load_data(data_dir: Path) -> dict:
    return {
        "subjects": read_csv(data_dir / "subjects.csv"),
        "specimens": read_csv(data_dir / "specimens.csv"),
        "crosswalk": read_csv(data_dir / "modality_crosswalk.csv"),
        "protein": read_csv(data_dir / "protein.csv"),
        "rna": read_csv(data_dir / "rna.csv"),
        "labels": read_csv(data_dir / "labels.csv", bool_cols=["observed"], int_cols=["y", "event_day"]),
        "observation_mask": read_csv(data_dir / "observation_mask.csv", bool_cols=["observed"]),
        "feature_dictionary": read_json(data_dir / "feature_dictionary.json"),
    }


def label_table(labels: pd.DataFrame, mask: pd.DataFrame) -> pd.DataFrame:
    """Labels with ``observed`` taken from observation_mask.csv (checked against labels.csv)."""
    for table, name in ((labels, "labels"), (mask, "observation_mask")):
        schema.require_columns(table, name)
        schema.require_unique(table, name)
    merged = labels.drop(columns=["observed"]).merge(mask, on=["subject_id", "task_id"], how="left",
                                                     validate="one_to_one")
    if merged["observed"].isna().any() or not merged["observed"].equals(labels["observed"]):
        raise ValueError("observation_mask.csv disagrees with labels.csv")
    schema.check_label_nulls(merged)
    return merged


def data_fingerprint(data_dir: Path) -> dict:
    files = {name: sha256_file(data_dir / name) for name in DATA_FILES}
    combined = sha256_bytes("\n".join(f"{k}:{v}" for k, v in sorted(files.items())).encode())
    return {"files": files, "combined_sha256": combined}


def write_split(members: pd.DataFrame, sid: str, root: Path) -> str:
    """Store the split once; a later run with the same split id must reproduce it exactly."""
    target = root / sid
    members_path = target / "members.csv"
    if members_path.exists():
        existing = read_csv(members_path)
        if not existing.equals(members.reset_index(drop=True)):
            raise RuntimeError(f"split {sid} differs from the stored copy")
    else:
        write_csv(members, members_path)
        write_csv(split.summarize(members), target / "summary.csv")
    return sha256_file(members_path)


def tensors(X, mask, y, observed, n_protein):
    return {
        "x_protein": torch.tensor(X[:, :n_protein], dtype=torch.float32),
        "x_rna": torch.tensor(X[:, n_protein:], dtype=torch.float32),
        "mask": torch.tensor(mask, dtype=torch.float32),
        "y": torch.tensor(y, dtype=torch.float32),
        "observed": torch.tensor(observed, dtype=torch.float32),
    }


def predict(model, X, mask, n_protein, rows):
    """Probabilities and attention weights for the given rows (each has a modality)."""
    model.eval()
    with torch.no_grad():
        logits, attn = model(torch.tensor(X[rows, :n_protein], dtype=torch.float32),
                             torch.tensor(X[rows, n_protein:], dtype=torch.float32),
                             torch.tensor(mask[rows], dtype=torch.float32), return_attention=True)
    return torch.sigmoid(logits).numpy().astype(np.float64), attn


def prediction_rows(frame, rows, scores, Y, OBS, split_of, scorable, run_id, sid) -> pd.DataFrame:
    out = []
    for i in np.flatnonzero(rows):
        rec = frame.iloc[i]
        for j, task in enumerate(TASK_IDS):
            out.append((run_id, rec["canonical_specimen_id"], rec["subject_id"], sid, split_of[i], task,
                        Y[i, j], bool(OBS[i, j]), scores[i, j], "scored" if scorable[i] else "abstain"))
    df = pd.DataFrame(out, columns=["run_id", "specimen_id", "subject_id", "split_id", "split", "task_id", "y",
                                    "observed", "score", "score_status"])
    df["y"] = df["y"].astype("Int64")
    return df


def attention_summary(attn, mask) -> pd.DataFrame:
    """Mean attention per head between the two modality tokens, over specimens with both modalities."""
    both = mask.sum(axis=1) == 2
    w = attn[torch.tensor(both)].numpy()
    tokens = ["protein", "rna"]
    rows = []
    for h in range(w.shape[1]):
        for q in range(2):
            for k in range(2):
                rows.append({"head": h, "query_token": tokens[q], "key_token": tokens[k],
                             "mean_weight": float(w[:, h, q, k].mean()), "n_specimens": int(w.shape[0])})
    return pd.DataFrame(rows)


OUTPUT_FILES = ["events.jsonl", "inputs.json", "predictions.csv", "metrics.json", "selection.json",
                "checkpoint.npz", "fit_membership.csv"]


def effective_config_sha256(cfg: DictConfig) -> str:
    """Hash of the resolved user configuration in a canonical, platform-independent form."""
    resolved = OmegaConf.to_container(cfg, resolve=True)
    return sha256_bytes(json.dumps(resolved, sort_keys=True, separators=(",", ":")).encode())


def run_pipeline(cfg: DictConfig, out_dir: Path) -> None:
    run_id = cfg.run_id
    if not run_id:
        raise ValueError("run_id must be set")
    existing = [name for name in OUTPUT_FILES if (out_dir / name).exists()]
    if existing:
        raise RuntimeError(f"{out_dir} already holds run outputs {existing}; run ids are not reused")
    events = EventLog(out_dir / "events.jsonl")
    try:
        _run(cfg, out_dir, events)
    except Exception as exc:
        events.add("end", status="error", error=type(exc).__name__)
        raise
    finally:
        events.close()


def _run(cfg: DictConfig, out_dir: Path, events: EventLog) -> None:
    run_id = cfg.run_id
    check_implemented(cfg)
    events.add("start", run_id=run_id, seed=int(cfg.seed))
    train.set_determinism(int(cfg.seed))

    data_dir = Path(cfg.data_dir)
    data = load_data(data_dir)
    fingerprint = data_fingerprint(data_dir)
    events.add("data_loaded", data_sha256=fingerprint["combined_sha256"])

    frame = pairing.assemble(data["protein"], data["rna"], data["crosswalk"], data["specimens"])
    events.add("paired", n_specimens=len(frame), join_key="canonical_specimen_id")

    members = split.assign_split(data["specimens"], cfg.split.unit, list(cfg.split.fractions), int(cfg.split.seed))
    sid = split.split_id(cfg.split.unit, list(cfg.split.fractions), int(cfg.split.seed))
    split_sha = write_split(members, sid, Path(cfg.splits_dir))
    events.add("split_assigned", split_id=sid, unit=cfg.split.unit,
               counts=split.summarize(members).to_dict("records"))
    inputs = {"seed": int(cfg.seed), "effective_config_sha256": effective_config_sha256(cfg),
              "data": fingerprint, "split_id": sid, "split_members_sha256": split_sha}
    write_json(inputs, out_dir / "inputs.json")

    features = prepare.select_features(data["feature_dictionary"], bool(cfg.data.features.allow_post_index))
    modalities = prepare.feature_modalities(data["feature_dictionary"], features)
    order = [f for f, m in zip(features, modalities) if m == "protein"]
    order += [f for f, m in zip(features, modalities) if m == "rna"]
    modalities = prepare.feature_modalities(data["feature_dictionary"], order)
    n_protein = modalities.count("protein")
    events.add("features_selected", n_features=len(order), n_protein=n_protein, n_rna=len(order) - n_protein,
               allow_post_index=bool(cfg.data.features.allow_post_index))

    state = prepare.fit_preprocessor(frame, members, cfg.preprocess.fit_scope, order, modalities)
    write_csv(state["fit_membership"], out_dir / "fit_membership.csv")
    prepare.save_state(state, out_dir / "preprocess_state.npz", {
        "split_id": sid, "split_members_sha256": split_sha,
        "fit_membership_sha256": sha256_file(out_dir / "fit_membership.csv")})
    events.add("preprocess_fit", fit_scope=cfg.preprocess.fit_scope,
               fit_splits=sorted(state["fit_membership"]["split"].unique().tolist()),
               n_fit_specimens=len(state["fit_membership"]))
    X, mask = prepare.transform(frame, state)

    labels = label_table(data["labels"], data["observation_mask"])
    wide_y = labels.pivot(index="subject_id", columns="task_id", values="y").loc[:, list(TASK_IDS)]
    wide_obs = labels.pivot(index="subject_id", columns="task_id", values="observed").loc[:, list(TASK_IDS)]
    Y = wide_y.loc[frame["subject_id"]].astype("Float64").to_numpy(dtype=float, na_value=np.nan)
    OBS = wide_obs.loc[frame["subject_id"]].to_numpy(dtype=bool)
    Y_filled = np.where(OBS, Y, 0.0)  # unobserved entries carry zero weight in the loss

    split_of = frame["canonical_specimen_id"].map(members.set_index("specimen_id")["split"]).to_numpy()
    scorable = mask.sum(axis=1) > 0
    tr = (split_of == "train") & scorable
    va = (split_of == "val") & scorable
    train_data = tensors(X[tr], mask[tr], Y_filled[tr], OBS[tr], n_protein)
    val_data = tensors(X[va], mask[va], Y_filled[va], OBS[va], n_protein)

    m = cfg.model
    model = build_model(m.kind, n_protein, len(order) - n_protein, len(TASK_IDS), int(m.width), int(m.heads))
    events.add("train_start", model=m.kind, train_role="train", n_train_specimens=int(tr.sum()),
               validation_role="val", n_val_specimens=int(va.sum()))
    ledger, states = train.train_model(
        model, train_data, val_data, int(m.max_epochs), float(m.learning_rate), int(m.batch_size), int(cfg.seed),
        on_epoch=lambda row: events.add("epoch_end", epoch=row["epoch"], train_loss=row["train_loss"],
                                        val_loss=row["val_loss"], params_sha256=row["params_sha256"]))
    ledger_df = pd.DataFrame(ledger)
    best = train.select_candidate(ledger_df, key="val_loss")
    best_epoch = int(best["epoch"])
    model.load_state_dict(states[best_epoch])
    events.add("checkpoint_selected", split="val", epoch=best_epoch, val_loss=float(best["val_loss"]))
    write_csv(ledger_df[["epoch", "train_loss", "val_loss"]], out_dir / "epoch_metrics.csv")
    write_jsonl([{"epoch": int(r["epoch"]), "params_sha256": r["params_sha256"], "val_loss": float(r["val_loss"]),
                  "selected": int(r["epoch"]) == best_epoch} for r in ledger], out_dir / "checkpoint_index.jsonl")
    np.savez(out_dir / "checkpoint.npz", **{k: v.cpu().numpy() for k, v in states[best_epoch].items()})

    # score the splits in the order they are used; rows without any modality abstain
    ev = cfg.evaluation
    th_split = cfg.selection.threshold_split
    grid_cfg = cfg.selection.threshold_grid
    grid = train.threshold_grid(float(grid_cfg.start), float(grid_cfg.stop), float(grid_cfg.step))
    scores = np.full((len(frame), len(TASK_IDS)), np.nan)
    pieces, thresholds, attention = {}, None, None
    for split_name in [th_split] + [s for s in split.SPLITS if s != th_split]:
        rows = split_of == split_name
        prob, attn = predict(model, X, mask, n_protein, rows & scorable)
        scores[rows & scorable] = prob
        if split_name == ev.split:
            attention = (attn, mask[rows & scorable])
        pieces[split_name] = prediction_rows(frame, rows, scores, Y, OBS, split_of, scorable, run_id, sid)
        role = "threshold_selection" if split_name == th_split else (
            "evaluation" if split_name == ev.split else "recorded")
        events.add("scored", split=split_name, role=role, n_specimens=int(rows.sum()),
                   n_abstain_specimens=int((rows & ~scorable).sum()))
        if split_name == th_split:
            thresholds = train.choose_threshold(evaluate.subject_scores(pieces[split_name]), labels, grid)
            events.add("threshold_selected", split=th_split,
                       thresholds={t: v["threshold"] for t, v in thresholds.items()})
            write_json({
                "checkpoint_split": "val",
                "selection_key": "val_loss",
                "selected_epoch": best_epoch,
                "selected_params_sha256": best["params_sha256"],
                "seed_candidates": [int(cfg.seed)],
                "threshold_split": th_split,
                "threshold_grid": {"start": float(grid_cfg.start), "stop": float(grid_cfg.stop),
                                   "step": float(grid_cfg.step), "n": int(len(grid))},
                "threshold_rule": "maximize F1 on subject-level scores with observed labels; "
                                  "ties -> smallest threshold",
                "thresholds": thresholds,
            }, out_dir / "selection.json")
    predictions = pd.concat([pieces[s] for s in split.SPLITS], ignore_index=True)
    predictions = predictions.sort_values(["specimen_id", "task_id"]).reset_index(drop=True)
    write_csv(predictions, out_dir / "predictions.csv")

    # evaluation
    eval_pred = predictions[predictions["split"] == ev.split]
    table = evaluate.scoring_labels(evaluate.subject_scores(eval_pred), labels, cfg.data.labels.unknown_policy)
    results = evaluate.evaluate_subjects(table, {t: v["threshold"] for t, v in thresholds.items()},
                                         int(ev.n_bootstrap), int(ev.bootstrap_seed), float(ev.ci_level))
    flow = report.build_flow(eval_pred, table, run_id, sid)
    write_csv(flow, out_dir / "flow.csv")
    coverage = report.coverage_summary(table, cfg.report.denominator_scope)
    counts = report.task_label_counts(table)
    for task, entry in results["tasks"].items():
        entry.update(counts[task])
    events.add("evaluated", split=ev.split, unknown_policy=cfg.data.labels.unknown_policy,
               macro_auroc=results["macro"]["auroc"])

    write_json({
        "run_id": run_id,
        "evaluation_split": ev.split,
        "unit": "subject_id",
        "averaging": "macro",
        "unknown_policy": cfg.data.labels.unknown_policy,
        "threshold_split": th_split,
        "coverage": coverage,
        "tasks": results["tasks"],
        "macro": results["macro"],
        "bootstrap": results["bootstrap"],
        "definitions": {
            "subject_score": "mean of scored aliquot scores of the subject within the evaluation split",
            "auroc": "sklearn.metrics.roc_auc_score on continuous subject scores",
            "ap": "sklearn.metrics.average_precision_score on continuous subject scores",
            "f1": "sklearn.metrics.f1_score with prediction = score >= threshold",
            "macro": "unweighted mean over tasks with both classes present",
            "not_evaluable": "a task without both classes among included subjects has null metrics",
            "rounding": "values are stored as float64; reports show 3 decimals (protocol/analysis_plan.yaml)",
        },
        "inputs": {
            "predictions_sha256": sha256_file(out_dir / "predictions.csv"),
            "labels_sha256": fingerprint["files"]["labels.csv"],
            "observation_mask_sha256": fingerprint["files"]["observation_mask.csv"],
            "split_members_sha256": split_sha,
            "selection_sha256": sha256_file(out_dir / "selection.json"),
        },
    }, out_dir / "metrics.json")

    attn, attn_mask = attention
    if attn is not None:
        write_csv(attention_summary(attn, attn_mask), out_dir / "attention_summary.csv")

    inputs.update({"n_features": len(order), "features": order})
    write_json(inputs, out_dir / "inputs.json")
    events.add("end", status="ok")


class RunDirGuard(Callback):
    """Stop before Hydra writes into a run directory that already holds outputs."""

    def on_run_start(self, config: DictConfig, **kwargs) -> None:
        run_dir = Path(config.hydra.run.dir)
        taken = [name for name in OUTPUT_FILES + [".hydra"] if (run_dir / name).exists()]
        if taken:
            raise RuntimeError(f"{run_dir} already holds run outputs {taken}; run ids are not reused")


@hydra.main(version_base="1.3", config_path="../configs", config_name="config")
def main(cfg: DictConfig) -> None:
    out_dir = Path(HydraConfig.get().runtime.output_dir)
    log.info("resolved config:\n%s", OmegaConf.to_yaml(cfg))
    run_pipeline(cfg, out_dir)


if __name__ == "__main__":
    main()
