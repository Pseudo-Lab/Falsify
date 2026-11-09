"""Small I/O helpers that keep written bytes identical across platforms.

All text outputs use LF line endings, booleans are written as ``true``/``false``
and missing values as empty fields, so that file hashes are reproducible.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _bool_text(value):
    if value is True or value is np.True_:
        return "true"
    if value is False or value is np.False_:
        return "false"
    return value


def write_csv(df: pd.DataFrame, path) -> None:
    """Write a CSV with LF endings, lowercase booleans and empty missing values."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    for col in out.columns:
        if out[col].dtype == bool or str(out[col].dtype) == "boolean":
            out[col] = out[col].map(_bool_text)
    out.to_csv(path, index=False, lineterminator="\n", na_rep="")


def read_csv(path, bool_cols=(), int_cols=()) -> pd.DataFrame:
    """Read a CSV written by :func:`write_csv`, restoring booleans and nullable ints."""
    df = pd.read_csv(path, keep_default_na=False, na_values=[""])
    for col in bool_cols:
        if col in df.columns:
            mapped = df[col].map({"true": True, "false": False, True: True, False: False})
            if mapped.isna().any():
                raise ValueError(f"{path}: column {col} must be true/false")
            df[col] = mapped.astype(bool)
    for col in int_cols:
        if col in df.columns:
            df[col] = df[col].astype("Int64")
    return df


def write_json(obj, path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, indent=2, sort_keys=False, ensure_ascii=False, default=_json_default)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text + "\n")


def write_jsonl(records, path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False, default=_json_default) + "\n")


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_text(text: str, path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _json_default(obj):
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if obj is pd.NA:
        return None
    raise TypeError(f"not JSON serializable: {type(obj)!r}")
