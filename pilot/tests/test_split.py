import pandas as pd

from src.split import assign_split, group_counts, summarize


def _specimens(n_subjects=50):
    rows = [(f"SYN-P{i:04d}-A{a}", f"SYN-P{i:04d}") for i in range(1, n_subjects + 1) for a in (1, 2)]
    return pd.DataFrame(rows, columns=["specimen_id", "subject_id"])


def test_group_counts_sum():
    assert group_counts(1200, [0.6, 0.2, 0.2]) == [720, 240, 240]


def test_subject_unit_keeps_aliquots_together():
    members = assign_split(_specimens(), "subject_id", [0.6, 0.2, 0.2], 1729)
    assert members.groupby("subject_id")["split"].nunique().max() == 1
    assert summarize(members)["overlap_subjects"].sum() == 0


def test_assignment_is_deterministic():
    a = assign_split(_specimens(), "subject_id", [0.6, 0.2, 0.2], 1729)
    b = assign_split(_specimens(), "subject_id", [0.6, 0.2, 0.2], 1729)
    pd.testing.assert_frame_equal(a, b)
