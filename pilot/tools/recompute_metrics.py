"""Recompute a run's evaluation from frozen predictions, labels and masks.

Usage: ``python -m tools.recompute_metrics --run <run_id>``

This is an independent implementation (numpy only; it does not import
``src``). By default it follows the run's own resolved configuration in
``runs/<run_id>/.hydra/config.yaml`` and compares every value with
``metrics.json``. Options can recompute under a different label policy or
threshold-selection split, in which case no comparison is made.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

TOL = 1e-9


def auroc(y, s):
    """Mann-Whitney AUROC with average ranks for ties."""
    y = np.asarray(y, int)
    s = np.asarray(s, float)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return None
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def average_precision(y, s):
    """Step-wise AP: sum over distinct score thresholds of (recall gain) x precision."""
    y = np.asarray(y, int)
    s = np.asarray(s, float)
    n1 = int(y.sum())
    if n1 == 0 or n1 == len(y):
        return None
    order = np.argsort(-s, kind="mergesort")
    ys, ss = y[order], s[order]
    last = np.r_[np.flatnonzero(np.diff(ss) != 0), len(ss) - 1]
    tp = np.cumsum(ys)[last]
    fp = (last + 1) - tp
    precision = tp / (tp + fp)
    recall = tp / n1
    return float(np.sum(np.diff(np.r_[0.0, recall]) * precision))


def f1(y, s, threshold):
    y = np.asarray(y, int)
    pred = np.asarray(s, float) >= threshold
    tp = int(np.sum(pred & (y == 1)))
    fp = int(np.sum(pred & (y == 0)))
    fn = int(np.sum(~pred & (y == 1)))
    return 0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn)


def _as_bool(series, name):
    mapped = series.astype(str).str.lower().map({"true": True, "false": False})
    if mapped.isna().any():
        raise SystemExit(f"{name}: observed must be true/false")
    return mapped.astype(bool)


def load_labels(data_dir: Path) -> pd.DataFrame:
    """y from labels.csv, observation from observation_mask.csv; the two files must agree."""
    labels = pd.read_csv(data_dir / "labels.csv", keep_default_na=False, na_values=[""])
    mask = pd.read_csv(data_dir / "observation_mask.csv", keep_default_na=False, na_values=[""])
    mask["observed"] = _as_bool(mask["observed"], "observation_mask.csv")
    labels["observed_in_labels"] = _as_bool(labels["observed"], "labels.csv")
    out = labels[["subject_id", "task_id", "y", "observed_in_labels"]].merge(
        mask[["subject_id", "task_id", "observed"]], on=["subject_id", "task_id"], how="left")
    if out["observed"].isna().any() or not (out["observed"] == out["observed_in_labels"]).all():
        raise SystemExit("observation_mask.csv disagrees with labels.csv")
    if not (out["y"].isna() == ~out["observed"].astype(bool)).all():
        raise SystemExit("labels: y must be null exactly when unobserved")
    return out.drop(columns=["observed_in_labels"])


def subject_table(pred: pd.DataFrame, split: str) -> pd.DataFrame:
    rows = pred[pred["split"] == split]
    scored = rows[rows["score_status"] == "scored"]
    mean = scored.groupby(["subject_id", "task_id"])["score"].mean().rename("score")
    planned = rows[["subject_id", "task_id"]].drop_duplicates().set_index(["subject_id", "task_id"])
    out = planned.join(mean).reset_index()
    out["scored"] = out["score"].notna()
    return out


def attach_labels(table: pd.DataFrame, labels: pd.DataFrame, policy: str) -> pd.DataFrame:
    out = table.merge(labels, on=["subject_id", "task_id"], how="left")
    if policy == "mask":
        out["y_eval"] = out["y"]
        out["included"] = out["scored"] & out["observed"]
    elif policy == "negative":
        out["y_eval"] = out["y"].fillna(0)
        out["included"] = out["scored"]
    else:
        raise SystemExit(f"unknown policy {policy}")
    return out


def reselect_thresholds(pred, labels, split, grid):
    table = attach_labels(subject_table(pred, split), labels, "mask")
    out = {}
    for task, grp in table[table["included"]].groupby("task_id"):
        y = grp["y_eval"].astype(int).to_numpy()
        s = grp["score"].to_numpy(float)
        values = [f1(y, s, t) for t in grid]
        out[task] = float(grid[int(np.argmax(values))])
    return out


def evaluate(table: pd.DataFrame, thresholds: dict, n_boot: int, seed: int, level: float) -> dict:
    tasks = sorted(table["task_id"].unique())
    pool = sorted(table.loc[table["scored"], "subject_id"].unique())
    index = {sid: i for i, sid in enumerate(pool)}
    S = np.full((len(pool), len(tasks)), np.nan)
    Y = np.full((len(pool), len(tasks)), np.nan)
    INC = np.zeros((len(pool), len(tasks)), bool)
    for rec in table[table["scored"]].itertuples(index=False):
        i, j = index[rec.subject_id], tasks.index(rec.task_id)
        S[i, j] = rec.score
        Y[i, j] = np.nan if pd.isna(rec.y_eval) else rec.y_eval
        INC[i, j] = bool(rec.included)

    def compute(rows):
        res = {}
        for j, task in enumerate(tasks):
            sel = rows[INC[rows, j]]
            y, s = Y[sel, j].astype(int), S[sel, j]
            evaluable = 0 < int(y.sum()) < len(y)  # both classes present
            res[task] = {"auroc": auroc(y, s), "ap": average_precision(y, s),
                         "f1": f1(y, s, thresholds[task]) if evaluable else None}
        macro = {}
        for m in ("auroc", "ap", "f1"):
            vals = [res[t][m] for t in tasks if res[t][m] is not None]
            macro[m] = float(np.mean(vals)) if vals else None
        return res, macro

    point, macro = compute(np.arange(len(pool)))
    draws = np.random.default_rng(seed).integers(0, len(pool), size=(n_boot, len(pool)))
    samples = {(t, m): [] for t in tasks + ["macro"] for m in ("auroc", "ap", "f1")}
    for rows in draws:
        res, mac = compute(rows)
        for m in ("auroc", "ap", "f1"):
            for t in tasks:
                samples[(t, m)].append(np.nan if res[t][m] is None else res[t][m])
            samples[("macro", m)].append(np.nan if mac[m] is None else mac[m])
    q = (100 * (1 - level) / 2, 100 * (1 + level) / 2)

    def ci(vals):
        arr = np.asarray(vals, float)
        arr = arr[~np.isnan(arr)]
        return [float(np.percentile(arr, q[0])), float(np.percentile(arr, q[1]))] if len(arr) else None

    out = {"tasks": {}, "macro": dict(macro)}
    for t in tasks:
        inc = INC[:, tasks.index(t)]
        rows_t = table[table["task_id"] == t]
        out["tasks"][t] = dict(point[t])
        out["tasks"][t]["threshold"] = thresholds[t]
        out["tasks"][t]["n_eval"] = int(inc.sum())
        out["tasks"][t]["n_positive"] = int(np.sum(Y[inc, tasks.index(t)] == 1))
        out["tasks"][t]["prevalence"] = float(np.mean(Y[inc, tasks.index(t)] == 1)) if inc.sum() else None
        out["tasks"][t]["n_planned"] = int(len(rows_t))
        out["tasks"][t]["n_scored"] = int(rows_t["scored"].sum())
        out["tasks"][t]["n_observed"] = int(rows_t["observed"].sum())
        out["tasks"][t]["n_unobserved"] = int((~rows_t["observed"].astype(bool)).sum())
        out["tasks"][t]["n_observed_scored"] = int((rows_t["observed"].astype(bool) & rows_t["scored"]).sum())
        out["tasks"][t]["ci"] = {m: ci(samples[(t, m)]) for m in ("auroc", "ap", "f1")}
    out["macro"]["ci"] = {m: ci(samples[("macro", m)]) for m in ("auroc", "ap", "f1")}
    status = table.groupby("subject_id")["scored"].any()
    out["coverage"] = {"n_planned": int(len(status)), "n_scored": int(status.sum()),
                       "n_abstain": int((~status).sum())}
    return out


def compare(recomputed: dict, stored: dict) -> list:
    """List of (field, recomputed, stored) that differ beyond tolerance."""
    diffs = []

    def check(name, a, b):
        if a is None or b is None:
            if a is not b:
                diffs.append((name, a, b))
        elif isinstance(a, list):
            for k, (x, z) in enumerate(zip(a, b)):
                check(f"{name}[{k}]", x, z)
        elif abs(float(a) - float(b)) > TOL:
            diffs.append((name, a, b))

    for t, entry in recomputed["tasks"].items():
        for m in ("auroc", "ap", "f1", "threshold", "n_eval", "n_positive", "prevalence", "n_planned", "n_scored",
                  "n_observed", "n_unobserved", "n_observed_scored"):
            check(f"tasks.{t}.{m}", entry[m], stored["tasks"][t][m])
        for m in ("auroc", "ap", "f1"):
            check(f"tasks.{t}.ci.{m}", entry["ci"][m], stored["tasks"][t]["ci"][m])
    for m in ("auroc", "ap", "f1"):
        check(f"macro.{m}", recomputed["macro"][m], stored["macro"][m])
        check(f"macro.ci.{m}", recomputed["macro"]["ci"][m], stored["macro"]["ci"][m])
    cov, scov = recomputed["coverage"], stored["coverage"]
    check("coverage.n_scored", cov["n_scored"], scov["n_scored"])
    if scov.get("denominator_scope") == "planned":
        check("coverage.n_planned", cov["n_planned"], scov["n_planned"])
        check("coverage.n_abstain", cov["n_abstain"], scov["n_abstain"])
    return diffs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Independent recomputation of run metrics.")
    parser.add_argument("--run", required=True)
    parser.add_argument("--runs-dir", default="runs")
    parser.add_argument("--unknown-policy", choices=["mask", "negative"])
    parser.add_argument("--threshold-split", choices=["val", "test"])
    parser.add_argument("--json", help="write the recomputed values to this path")
    args = parser.parse_args(argv)

    run_dir = Path(args.runs_dir) / args.run
    cfg = yaml.safe_load((run_dir / ".hydra" / "config.yaml").read_text(encoding="utf-8"))
    pred = pd.read_csv(run_dir / "predictions.csv", keep_default_na=False, na_values=[""])
    pred["score"] = pred["score"].astype(float)
    split_ids = pred["split_id"].unique()
    members = pd.read_csv(Path(cfg["splits_dir"]) / split_ids[0] / "members.csv")
    check = pred[["specimen_id", "split"]].drop_duplicates().merge(members, on="specimen_id", how="left",
                                                                  suffixes=("", "_stored"))
    if len(split_ids) != 1 or not (check["split"] == check["split_stored"]).all():
        raise SystemExit("predictions.csv split assignment differs from splits/<split_id>/members.csv")
    labels = load_labels(Path(cfg["data_dir"]))
    selection = json.loads((run_dir / "selection.json").read_text(encoding="utf-8"))
    stored = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))

    policy = args.unknown_policy or cfg["data"]["labels"]["unknown_policy"]
    if args.threshold_split:
        g = selection["threshold_grid"]
        grid = np.round(g["start"] + g["step"] * np.arange(g["n"]), 10)
        thresholds = reselect_thresholds(pred, labels, args.threshold_split, grid)
    else:
        thresholds = {t: v["threshold"] for t, v in selection["thresholds"].items()}
        g = selection["threshold_grid"]
        grid = np.round(g["start"] + g["step"] * np.arange(g["n"]), 10)
        again = reselect_thresholds(pred, labels, selection["threshold_split"], grid)
        if again != thresholds:
            print(f"  MISMATCH thresholds re-selected on {selection['threshold_split']}: {again} vs {thresholds}")
            return 1
    ev = cfg["evaluation"]
    table = attach_labels(subject_table(pred, ev["split"]), labels, policy)
    result = evaluate(table, thresholds, int(ev["n_bootstrap"]), int(ev["bootstrap_seed"]), float(ev["ci_level"]))
    result.update({"run_id": args.run, "unknown_policy": policy, "thresholds": thresholds})
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    print(f"run {args.run}: policy={policy} planned={result['coverage']['n_planned']} "
          f"scored={result['coverage']['n_scored']} abstain={result['coverage']['n_abstain']} "
          f"(stored coverage scope: {stored['coverage'].get('denominator_scope')})")
    def fmt(v):
        return "NA" if v is None else f"{v:.6f}"

    for t, e in result["tasks"].items():
        print(f"  {t}: n_eval={e['n_eval']} pos={e['n_positive']} auroc={fmt(e['auroc'])} "
              f"ap={fmt(e['ap'])} f1={fmt(e['f1'])} thr={thresholds[t]:.2f}")
    print(f"  macro: auroc={fmt(result['macro']['auroc'])} ap={fmt(result['macro']['ap'])} "
          f"f1={fmt(result['macro']['f1'])}")
    if args.unknown_policy or args.threshold_split:
        print("custom settings: comparison with metrics.json skipped")
        return 0
    diffs = compare(result, stored)
    if diffs:
        for name, a, b in diffs[:20]:
            print(f"  MISMATCH {name}: recomputed={a} stored={b}")
        print(f"{len(diffs)} mismatches")
        return 1
    print(f"all values match metrics.json (tolerance {TOL})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
