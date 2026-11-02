"""Resampling-unit example for confidence intervals.

Subjects are drawn with replacement and every aliquot of a drawn subject is
kept together. The output lists, for a few replicates, the sampled subjects
and the specimen rows they bring.

Usage: ``python -m examples.contracts.bootstrap_example``
"""

from pathlib import Path

import pandas as pd

from src.evaluate import bootstrap_ids
from src.io_utils import write_json

HERE = Path(__file__).parent
N_BOOT = 5
SEED = 7


def build() -> dict:
    frame = pd.read_csv(HERE / "bootstrap_input.csv")
    reps = bootstrap_ids(frame, N_BOOT, SEED)
    out = []
    for rows, sampled in reps:
        specimens = frame["specimen_id"].to_numpy()[rows].tolist()
        out.append({"sampled_subject_ids": [str(s) for s in sampled], "specimen_rows": specimens})
    return {"unit": "subject_id", "n_boot": N_BOOT, "seed": SEED, "replicates": out}


if __name__ == "__main__":
    out = build()
    write_json(out, HERE / "bootstrap_output.json")
    print(out["replicates"][0])
