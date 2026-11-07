import pandas as pd
import pytest

from src.schema import TASK_IDS, check_label_nulls, require_unique, subject_of


def test_specimen_ids_expose_their_subject():
    assert subject_of("SYN-P0001-A2") == "SYN-P0001"
    with pytest.raises(ValueError):
        subject_of("SYN-P0001-B1")


def test_six_synthetic_tasks():
    assert TASK_IDS == ("SYN_T01", "SYN_T02", "SYN_T03", "SYN_T04", "SYN_T05", "SYN_T06")


def test_null_label_must_be_unobserved():
    ok = pd.DataFrame({"y": pd.array([1, 0, None], "Int64"), "observed": [True, True, False]})
    check_label_nulls(ok)
    bad = pd.DataFrame({"y": pd.array([None], "Int64"), "observed": [True]})
    with pytest.raises(ValueError):
        check_label_nulls(bad)


def test_duplicate_keys_are_rejected():
    df = pd.DataFrame({"subject_id": ["SYN-P0001", "SYN-P0001"], "task_id": ["SYN_T01", "SYN_T01"]})
    with pytest.raises(ValueError):
        require_unique(df, "labels")
