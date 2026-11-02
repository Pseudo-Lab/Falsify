import pandas as pd
import pytest

from src.labels import build_labels, endpoint_status, within_horizon


def test_events_inside_window_are_positive():
    assert endpoint_status(179, 365) == (1, True)
    assert endpoint_status(180, 365) == (1, True)


def test_event_after_horizon_is_not_a_180_day_positive():
    assert within_horizon(181) is False
    assert endpoint_status(181, 365) == (0, True)


def test_censored_without_event_is_unobserved():
    assert endpoint_status(None, 90) == (None, False)
    assert endpoint_status(pd.NA, 179) == (None, False)


def test_event_before_censoring_is_observed_positive():
    assert endpoint_status(30, 90) == (1, True)


def test_event_after_followup_is_rejected():
    with pytest.raises(ValueError):
        endpoint_status(120, 90)


def test_build_labels_columns_and_nulls():
    events = pd.DataFrame({"subject_id": ["SYN-P0001", "SYN-P0002"], "task_id": ["SYN_T01", "SYN_T01"],
                           "event_day": pd.array([None, 20], dtype="Int64"), "followup_end_day": [100, 365]})
    out = build_labels(events)
    assert out["y"].isna().tolist() == [True, False]
    assert out["observed"].tolist() == [False, True]
