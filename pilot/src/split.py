"""Grouped train/validation/test assignment.

``assign_split`` shuffles the distinct values of the grouping column with a
fixed seed and cuts them by the requested fractions. With ``unit=subject_id``
all aliquots of a subject land in the same split.
"""

import hashlib
import json

import numpy as np
import pandas as pd

SPLITS = ("train", "val", "test")


def split_id(unit: str, fractions, seed: int) -> str:
    spec = json.dumps({"unit": unit, "fractions": [float(f) for f in fractions], "seed": int(seed)}, sort_keys=True)
    return "split_" + hashlib.sha256(spec.encode()).hexdigest()[:10]


def group_counts(n_groups: int, fractions) -> list:
    """Integer group counts per split; rounding remainder goes to the last split."""
    if not np.isclose(sum(fractions), 1.0):
        raise ValueError("fractions must sum to 1")
    counts = [int(round(f * n_groups)) for f in fractions[:-1]]
    counts.append(n_groups - sum(counts))
    return counts


def assign_split(specimens: pd.DataFrame, unit: str, fractions, seed: int) -> pd.DataFrame:
    """Return specimen_id, subject_id, split for every specimen.

    ``unit`` names the column whose distinct values are assigned as groups.
    """
    if unit not in specimens.columns:
        raise ValueError(f"unknown split unit {unit!r}")
    groups = np.array(sorted(specimens[unit].unique()))
    rng = np.random.default_rng(seed)
    order = groups[rng.permutation(len(groups))]
    counts = group_counts(len(groups), fractions)
    labels = np.repeat(np.array(SPLITS), counts)
    assignment = dict(zip(order, labels))
    out = specimens[["specimen_id", "subject_id"]].copy()
    out["split"] = out[unit].map(assignment)
    return out.sort_values("specimen_id").reset_index(drop=True)


def summarize(members: pd.DataFrame) -> pd.DataFrame:
    """Per-split specimen and subject counts plus subjects shared with other splits."""
    rows = []
    subjects = {s: set(members.loc[members["split"] == s, "subject_id"]) for s in SPLITS}
    for s in SPLITS:
        others = set().union(*(subjects[o] for o in SPLITS if o != s))
        rows.append({
            "split": s,
            "n_specimens": int((members["split"] == s).sum()),
            "n_subjects": len(subjects[s]),
            "overlap_subjects": len(subjects[s] & others),
        })
    return pd.DataFrame(rows)
