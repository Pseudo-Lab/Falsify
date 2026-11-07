"""Macro versus micro aggregation on two tasks with different size and prevalence.

The macro AUROC is the unweighted mean of per-task AUROC. The micro AUROC
pools all (y, score) pairs; it is a legitimate but different quantity and is
reported here only for contrast.

Usage: ``python -m examples.contracts.aggregation_example``
"""

from pathlib import Path

import pandas as pd
from sklearn.metrics import roc_auc_score

from src.evaluate import aggregate_auc
from src.io_utils import write_json

HERE = Path(__file__).parent


def build() -> dict:
    df = pd.read_csv(HERE / "aggregation_input.csv")
    task_data = {t: (g["y"].to_numpy(), g["score"].to_numpy()) for t, g in df.groupby("task_id")}
    per_task = {t: float(roc_auc_score(y, s)) for t, (y, s) in task_data.items()}
    return {
        "per_task_auroc": per_task,
        "per_task_n": {t: int(len(y)) for t, (y, _) in task_data.items()},
        "per_task_prevalence": {t: float(y.mean()) for t, (y, _) in task_data.items()},
        "macro_auroc": aggregate_auc(task_data),
        "micro_auroc_for_contrast": float(roc_auc_score(df["y"], df["score"])),
    }


if __name__ == "__main__":
    out = build()
    write_json(out, HERE / "aggregation_output.json")
    print(out)
