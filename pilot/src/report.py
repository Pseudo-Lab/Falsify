"""Evaluation flow and coverage summary.

The flow keeps every planned specimen of the evaluation split, including
aliquots and subjects that abstained, so the path from planned rows to the
rows inside each metric can be recomputed.
"""

import pandas as pd

DENOMINATOR_SCOPES = ("planned", "scored")


def build_flow(predictions: pd.DataFrame, scored_table: pd.DataFrame, run_id: str, split_id: str) -> pd.DataFrame:
    """One row per (specimen, task) of the evaluation split.

    ``predictions`` are the specimen rows of that split; ``scored_table`` is
    the subject-level output of ``evaluate.scoring_labels``.
    """
    subj = scored_table[["subject_id", "task_id", "score", "n_aliquots_scored", "score_status", "y_eval", "included",
                         "exclusion_reason"]].rename(
        columns={"score": "subject_score", "n_aliquots_scored": "subject_n_aliquots_scored",
                 "score_status": "subject_score_status"})
    flow = predictions[["specimen_id", "subject_id", "task_id", "y", "observed", "score", "score_status"]].rename(
        columns={"y": "y_raw", "score": "specimen_score", "score_status": "specimen_score_status"})
    flow = flow.merge(subj, on=["subject_id", "task_id"], how="left", validate="many_to_one")
    flow.insert(0, "run_id", run_id)
    flow.insert(4, "split_id", split_id)
    return flow.sort_values(["specimen_id", "task_id"]).reset_index(drop=True)


def coverage_summary(scored_table: pd.DataFrame, denominator_scope: str) -> dict:
    """Subjects planned, scored and abstaining in the evaluation split.

    ``planned`` reports scored subjects against all planned subjects and lists
    the abstentions; ``scored`` reports the scored subjects as the population.
    """
    if denominator_scope not in DENOMINATOR_SCOPES:
        raise ValueError(f"unknown denominator_scope {denominator_scope!r}")
    status = scored_table.groupby("subject_id")["score_status"].first()
    n_planned = int(len(status))
    scored_ids = sorted(status[status == "scored"].index)
    abstain_ids = sorted(status[status == "abstain"].index)
    if denominator_scope == "planned":
        return {
            "denominator_scope": "planned",
            "population": "evaluation split subjects",
            "n_planned": n_planned,
            "n_scored": len(scored_ids),
            "n_abstain": len(abstain_ids),
            "coverage": len(scored_ids) / n_planned if n_planned else None,
            "abstain_subject_ids": abstain_ids,
        }
    return {
        "denominator_scope": "scored",
        "population": "evaluation split subjects",
        "n_subjects": len(scored_ids),
        "n_scored": len(scored_ids),
        "coverage": 1.0 if scored_ids else None,
    }


def task_label_counts(scored_table: pd.DataFrame) -> dict:
    """Per task: planned subjects, observed / unobserved labels among them."""
    out = {}
    for task, grp in scored_table.groupby("task_id", sort=True):
        out[task] = {
            "n_planned": int(len(grp)),
            "n_scored": int((grp["score_status"] == "scored").sum()),
            "n_observed": int(grp["observed"].sum()),
            "n_unobserved": int((~grp["observed"]).sum()),
            "n_observed_scored": int((grp["observed"] & (grp["score_status"] == "scored")).sum()),
        }
    return out
