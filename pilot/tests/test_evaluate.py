import numpy as np
import pandas as pd

from src.evaluate import aggregate_auc, bootstrap_ids, scoring_labels, subject_scores


def test_subject_score_is_mean_of_scored_aliquots():
    pred = pd.DataFrame({"subject_id": ["s1", "s1", "s2", "s2"], "task_id": "T",
                         "score": [0.2, 0.4, np.nan, np.nan],
                         "score_status": ["scored", "scored", "abstain", "abstain"]})
    out = subject_scores(pred).set_index("subject_id")
    assert np.isclose(out.loc["s1", "score"], 0.3)
    assert out.loc["s2", "score_status"] == "abstain"


def test_mask_policy_excludes_unobserved_labels():
    table = pd.DataFrame({"subject_id": ["s1", "s2"], "task_id": "T", "score": [0.3, 0.6], "score_status": "scored"})
    labels = pd.DataFrame({"subject_id": ["s1", "s2"], "task_id": "T", "y": pd.array([1, None], "Int64"),
                           "observed": [True, False]})
    masked = scoring_labels(table, labels, "mask")
    assert masked["included"].tolist() == [True, False]
    filled = scoring_labels(table, labels, "negative")
    assert filled["included"].tolist() == [True, True]
    assert filled["y_eval"].tolist() == [1, 0]


def test_macro_is_unweighted_mean_of_task_auroc():
    task_data = {"A": (np.array([1, 0, 1, 0]), np.array([0.9, 0.1, 0.4, 0.6])),
                 "B": (np.array([1, 0, 0, 0, 0, 0]), np.array([0.9, 0.1, 0.2, 0.3, 0.4, 0.5]))}
    assert np.isclose(aggregate_auc(task_data), (0.75 + 1.0) / 2)


def test_bootstrap_keeps_aliquots_of_a_subject_together():
    frame = pd.DataFrame({"subject_id": ["s1", "s1", "s2", "s2", "s3", "s3"],
                          "specimen_id": ["s1a", "s1b", "s2a", "s2b", "s3a", "s3b"]})
    for rows, sampled in bootstrap_ids(frame, 20, 5):
        picked = frame.iloc[rows]
        assert len(picked) == 2 * len(sampled)
        assert (picked.groupby("subject_id").size() % 2 == 0).all()


def test_bootstrap_is_reproducible():
    frame = pd.DataFrame({"subject_id": ["s1", "s2", "s3", "s4"]})
    a = [tuple(rows) for rows, _ in bootstrap_ids(frame, 10, 11)]
    b = [tuple(rows) for rows, _ in bootstrap_ids(frame, 10, 11)]
    assert a == b and len(a) == 10
