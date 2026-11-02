"""The pipeline's evaluation and the independent recomputation agree on a small fixture.

The fixture has abstaining subjects, unobserved labels, one- and two-aliquot
subjects, tied scores and a low-prevalence task.
"""

import numpy as np
import pandas as pd
import pytest

from src import evaluate, report
from tools import recompute_metrics as rc


def _fixture(seed=3):
    rng = np.random.default_rng(seed)
    pred_rows, label_rows = [], []
    for i in range(60):
        sid = f"S{i:03d}"
        n_aliquots = 1 if i % 7 == 0 else 2
        abstain = i % 13 == 0
        for task, rate in (("T1", 0.4), ("T2", 0.1)):
            observed = i % 9 != 0
            y = int(rng.random() < rate) if observed else None
            label_rows.append((sid, task, y, observed))
            for a in range(n_aliquots):
                score = None if abstain else float(np.round(rng.random(), 1))
                pred_rows.append((f"{sid}-A{a + 1}", sid, "test", task, score, "abstain" if abstain else "scored"))
    pred = pd.DataFrame(pred_rows, columns=["specimen_id", "subject_id", "split", "task_id", "score", "score_status"])
    labels = pd.DataFrame(label_rows, columns=["subject_id", "task_id", "y", "observed"])
    labels["y"] = labels["y"].astype("Int64")
    return pred, labels


@pytest.mark.parametrize("policy", ["mask", "negative"])
def test_pipeline_and_recompute_agree(policy):
    pred, labels = _fixture()
    thresholds = {"T1": 0.45, "T2": 0.35}
    table = evaluate.scoring_labels(evaluate.subject_scores(pred), labels, policy)
    stored = evaluate.evaluate_subjects(table, thresholds, n_boot=200, seed=5, ci_level=0.95)
    counts = report.task_label_counts(table)
    for task, entry in stored["tasks"].items():
        entry.update(counts[task])
    stored["coverage"] = report.coverage_summary(table, "planned")

    rlabels = labels.assign(y=labels["y"].astype("float"))
    rtable = rc.attach_labels(rc.subject_table(pred, "test"), rlabels, policy)
    recomputed = rc.evaluate(rtable, thresholds, 200, 5, 0.95)
    assert rc.compare(recomputed, stored) == []


def test_coverage_summary_scopes():
    pred, labels = _fixture()
    table = evaluate.scoring_labels(evaluate.subject_scores(pred), labels, "mask")
    planned = report.coverage_summary(table, "planned")
    assert planned["n_planned"] == 60 and planned["n_abstain"] == len(planned["abstain_subject_ids"]) > 0
    scored = report.coverage_summary(table, "scored")
    assert scored["n_subjects"] == planned["n_scored"] and scored["coverage"] == 1.0


def test_flow_keeps_abstaining_subjects():
    pred, labels = _fixture()
    table = evaluate.scoring_labels(evaluate.subject_scores(pred), labels, "mask")
    pred = pred.assign(y=pred.merge(labels, on=["subject_id", "task_id"])["y"].to_numpy(),
                       observed=pred.merge(labels, on=["subject_id", "task_id"])["observed"].to_numpy())
    flow = report.build_flow(pred, table, "run_x", "split_x")
    assert len(flow) == len(pred)
    assert set(flow.loc[flow["subject_score_status"] == "abstain", "exclusion_reason"]) == {"subject_abstain"}
