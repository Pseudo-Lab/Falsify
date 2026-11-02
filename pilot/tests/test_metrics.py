"""Hand-checkable metric fixtures and agreement of the two metric implementations."""

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from src.evaluate import task_metrics
from tools.recompute_metrics import auroc, average_precision, f1


def test_hand_checked_values():
    y = np.array([1, 0, 1, 0, 0])
    s = np.array([0.9, 0.8, 0.7, 0.3, 0.3])
    # positives outrank 5 of the 6 positive-negative pairs
    assert np.isclose(auroc(y, s), 5 / 6)
    # cut at 0.9: P=1, R=0.5; cut at 0.7: P=2/3, R=1 -> AP = 0.5*1 + 0.5*2/3
    assert np.isclose(average_precision(y, s), 0.5 + 0.5 * 2 / 3)
    # threshold 0.75 predicts 1,1,0,0,0 -> tp=1, fp=1, fn=1 -> F1 = 0.5
    assert np.isclose(f1(y, s, 0.75), 0.5)
    m = task_metrics(y, s, 0.75)
    assert np.isclose(m["auroc"], 5 / 6) and np.isclose(m["ap"], 0.5 + 0.5 * 2 / 3) and np.isclose(m["f1"], 0.5)


def test_independent_implementation_matches_sklearn():
    rng = np.random.default_rng(0)
    checked = 0
    for _ in range(60):
        n = int(rng.integers(5, 60))
        y = rng.integers(0, 2, n)
        if y.min() == y.max():
            continue
        s = np.round(rng.random(n), 2)  # rounding creates ties
        assert abs(auroc(y, s) - roc_auc_score(y, s)) < 1e-12
        assert abs(average_precision(y, s) - average_precision_score(y, s)) < 1e-12
        checked += 1
    assert checked > 40
