"""Subject-level evaluation: per-task AUROC/AP/F1, macro averages, subject bootstrap.

* Specimen scores are averaged within each subject (only aliquots that belong
  to the evaluated split and were scored). A subject with no scored aliquot
  abstains.
* ``scoring_labels`` decides which subject labels enter evaluation.
* Task metrics use continuous scores for AUROC and AP and the fixed threshold
  for F1. Macro averages are unweighted means over evaluable tasks.
* Confidence intervals resample subjects with replacement; every row of a
  sampled subject comes along.
"""

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, f1_score, roc_auc_score

UNKNOWN_POLICIES = ("mask", "negative")


def subject_scores(predictions: pd.DataFrame) -> pd.DataFrame:
    """Average scored aliquots per (subject, task).

    ``predictions`` holds specimen rows of one split with subject_id, task_id,
    score and score_status.
    """
    scored = predictions[predictions["score_status"] == "scored"]
    agg = scored.groupby(["subject_id", "task_id"], sort=True)["score"].agg(["mean", "size"]).reset_index()
    agg = agg.rename(columns={"mean": "score", "size": "n_aliquots_scored"})
    planned = predictions[["subject_id", "task_id"]].drop_duplicates()
    out = planned.merge(agg, on=["subject_id", "task_id"], how="left", validate="one_to_one")
    out["n_aliquots_scored"] = out["n_aliquots_scored"].fillna(0).astype(int)
    out["score_status"] = np.where(out["n_aliquots_scored"] > 0, "scored", "abstain")
    return out.sort_values(["subject_id", "task_id"]).reset_index(drop=True)


def scoring_labels(subject_table: pd.DataFrame, labels: pd.DataFrame, unknown_policy: str) -> pd.DataFrame:
    """Attach the labels used for evaluation and the inclusion flag.

    ``mask``: unobserved labels stay null and are excluded.
    ``negative``: unobserved labels are evaluated as 0.
    Abstaining subjects are excluded under both policies.
    """
    if unknown_policy not in UNKNOWN_POLICIES:
        raise ValueError(f"unknown unknown_policy {unknown_policy!r}")
    out = subject_table.merge(labels[["subject_id", "task_id", "y", "observed"]],
                              on=["subject_id", "task_id"], how="left", validate="one_to_one")
    scored = out["score_status"] == "scored"
    if unknown_policy == "mask":
        out["y_eval"] = out["y"]
        out["included"] = scored & out["observed"]
    else:
        out["y_eval"] = out["y"].fillna(0).astype("Int64")
        out["included"] = scored
    out["exclusion_reason"] = np.select(
        [~scored, ~out["included"]], ["subject_abstain", "label_unobserved"], default="")
    return out


def task_metrics(y: np.ndarray, score: np.ndarray, threshold: float) -> dict:
    """AUROC and AP on continuous scores, F1 at ``threshold``.

    A task is evaluable only when both classes are present; otherwise every
    metric is None, so all macro averages use the same set of tasks.
    """
    y = np.asarray(y, dtype=int)
    score = np.asarray(score, dtype=float)
    if len(np.unique(y)) != 2:
        return {"auroc": None, "ap": None, "f1": None}
    return {
        "auroc": float(roc_auc_score(y, score)),
        "ap": float(average_precision_score(y, score)),
        "f1": float(f1_score(y, (score >= threshold).astype(int), zero_division=0.0)),
    }


def macro_mean(values) -> float:
    """Unweighted mean over evaluable tasks (None marks a task that is not evaluable)."""
    vals = [v for v in values if v is not None and not np.isnan(v)]
    return float(np.mean(vals)) if vals else float("nan")


def aggregate_auc(task_data: dict) -> float:
    """Macro AUROC: unweighted mean of per-task AUROC over evaluable tasks.

    ``task_data`` maps task_id -> (y, score).
    """
    values = []
    for y, score in task_data.values():
        if len(np.unique(y)) == 2:
            values.append(roc_auc_score(y, score))
    return macro_mean(values)


def bootstrap_ids(frame: pd.DataFrame, n_boot: int, seed: int, unit: str = "subject_id"):
    """Resample ``unit`` values with replacement; return row positions per replicate.

    Each replicate holds every row of each sampled unit (a unit drawn twice
    contributes its rows twice), plus the sampled unit ids.
    """
    units = np.array(sorted(frame[unit].unique()))
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(units), size=(n_boot, len(units)))
    positions = {u: np.flatnonzero(frame[unit].to_numpy() == u) for u in units}
    replicates = []
    for row in draws:
        sampled = units[row]
        replicates.append((np.concatenate([positions[u] for u in sampled]), sampled))
    return replicates


def evaluate_subjects(table: pd.DataFrame, thresholds: dict, n_boot: int, seed: int, ci_level: float) -> dict:
    """Point estimates and subject-bootstrap percentile intervals.

    ``table`` is the output of :func:`scoring_labels` for the evaluation split.
    """
    tasks = sorted(table["task_id"].unique())
    wide_score = table.pivot(index="subject_id", columns="task_id", values="score")
    wide_y = table.pivot(index="subject_id", columns="task_id", values="y_eval")
    wide_inc = table.pivot(index="subject_id", columns="task_id", values="included").astype(bool)
    status = table.groupby("subject_id")["score_status"].first()
    pool = status[status == "scored"].index
    S = wide_score.loc[pool, tasks].to_numpy(dtype=float)
    Y = wide_y.loc[pool, tasks].astype("Float64").to_numpy(dtype=float, na_value=np.nan)
    INC = wide_inc.loc[pool, tasks].to_numpy()

    def compute(rows):
        per_task, task_data = {}, {}
        for j, task in enumerate(tasks):
            sel = rows[INC[rows, j]]
            per_task[task] = task_metrics(Y[sel, j], S[sel, j], thresholds[task])
            task_data[task] = (Y[sel, j].astype(int), S[sel, j])
        macro = {"auroc": aggregate_auc(task_data)}
        macro.update({m: macro_mean([per_task[t][m] for t in tasks]) for m in ("ap", "f1")})
        return per_task, macro

    point_tasks, point_macro = compute(np.arange(len(pool)))
    frame = pd.DataFrame({"subject_id": np.array(pool)})
    reps = bootstrap_ids(frame, n_boot, seed)
    boot = {m: {t: [] for t in tasks} for m in ("auroc", "ap", "f1")}
    boot_macro = {m: [] for m in ("auroc", "ap", "f1")}
    for rows, _ in reps:
        per_task, macro = compute(rows)
        for m in ("auroc", "ap", "f1"):
            for t in tasks:
                v = per_task[t][m]
                boot[m][t].append(np.nan if v is None else v)
            boot_macro[m].append(macro[m])
    lo_q, hi_q = 100 * (1 - ci_level) / 2, 100 * (1 + ci_level) / 2

    def interval(samples):
        arr = np.asarray(samples, dtype=float)
        arr = arr[~np.isnan(arr)]
        if len(arr) == 0:
            return None, 0
        return [float(np.percentile(arr, lo_q)), float(np.percentile(arr, hi_q))], int(len(arr))

    task_out = {}
    for j, task in enumerate(tasks):
        inc = INC[:, j]
        y = Y[inc, j]
        entry = dict(point_tasks[task])
        entry.update({
            "threshold": thresholds[task],
            "n_eval": int(inc.sum()),
            "n_positive": int(np.sum(y == 1)),
            "prevalence": float(np.mean(y == 1)) if inc.sum() else None,
        })
        entry["ci"] = {}
        for m in ("auroc", "ap", "f1"):
            ci, n_valid = interval(boot[m][task])
            entry["ci"][m] = ci
            entry["ci"][f"{m}_n_valid"] = n_valid
        task_out[task] = entry
    macro_out = dict(point_macro)
    macro_out["n_tasks"] = int(sum(point_tasks[t]["auroc"] is not None for t in tasks))
    macro_out["ci"] = {}
    for m in ("auroc", "ap", "f1"):
        ci, n_valid = interval(boot_macro[m])
        macro_out["ci"][m] = ci
        macro_out["ci"][f"{m}_n_valid"] = n_valid
    return {
        "tasks": task_out,
        "macro": macro_out,
        "bootstrap": {"unit": "subject_id", "pool": "scored subjects of the evaluation split",
                      "n_pool": int(len(pool)), "n_boot": int(n_boot), "seed": int(seed),
                      "ci_level": ci_level, "percentile_method": "numpy.percentile (linear)"},
    }
