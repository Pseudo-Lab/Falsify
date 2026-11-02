"""Cohort schema: identifiers, column contracts and null rules.

Identifiers expose parent relations: a specimen ``SYN-P0001-A1`` belongs to
subject ``SYN-P0001``. Labels use ``y`` in {0, 1, null}; ``observed`` is false
exactly when ``y`` is null. Label observation and modality availability are
kept in separate tables and are never merged into one missing-value flag.
"""

import re

import pandas as pd

SUBJECT_PATTERN = re.compile(r"^SYN-P\d{4}$")
SPECIMEN_PATTERN = re.compile(r"^(SYN-P\d{4})-A([12])$")

TASK_IDS = tuple(f"SYN_T{i:02d}" for i in range(1, 7))
SITE_IDS = ("SITE_A", "SITE_B", "SITE_C")
HORIZON_DAYS = 180
MODALITIES = ("protein", "rna")

COLUMNS = {
    "subjects": ["subject_id", "site_id", "index_day", "followup_end_day"],
    "specimens": ["specimen_id", "subject_id", "aliquot_index", "collection_day"],
    "modality_crosswalk": ["canonical_specimen_id", "protein_local_id", "rna_local_id"],
    "labels": ["subject_id", "task_id", "event_day", "followup_end_day", "y", "observed"],
    "observation_mask": ["subject_id", "task_id", "observed"],
    "modality_mask": ["specimen_id", "protein_available", "rna_available"],
}

KEYS = {
    "subjects": ["subject_id"],
    "specimens": ["specimen_id"],
    "modality_crosswalk": ["canonical_specimen_id"],
    "labels": ["subject_id", "task_id"],
    "observation_mask": ["subject_id", "task_id"],
    "modality_mask": ["specimen_id"],
}


def subject_of(specimen_id: str) -> str:
    """Return the parent subject of a specimen identifier."""
    match = SPECIMEN_PATTERN.match(specimen_id)
    if match is None:
        raise ValueError(f"malformed specimen_id: {specimen_id!r}")
    return match.group(1)


def require_columns(df: pd.DataFrame, table: str) -> None:
    missing = [c for c in COLUMNS[table] if c not in df.columns]
    if missing:
        raise ValueError(f"{table}: missing columns {missing}")


def require_unique(df: pd.DataFrame, table: str) -> None:
    key = KEYS[table]
    dup = df.duplicated(subset=key, keep=False)
    if dup.any():
        raise ValueError(f"{table}: duplicate keys {df.loc[dup, key].head().to_dict('records')}")


def check_label_nulls(labels: pd.DataFrame) -> None:
    """``observed`` must be false exactly when ``y`` is null."""
    y_null = labels["y"].isna()
    bad = y_null != ~labels["observed"].astype(bool)
    if bad.any():
        raise ValueError(f"labels: y/observed mismatch in {int(bad.sum())} rows")
    values = set(labels.loc[~y_null, "y"].astype(int).unique())
    if not values <= {0, 1}:
        raise ValueError(f"labels: y outside {{0, 1}}: {sorted(values)}")
