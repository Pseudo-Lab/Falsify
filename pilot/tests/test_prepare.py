import numpy as np
import pandas as pd

from src.prepare import fit_preprocessor, select_features, transform

DICT = {"prediction_time_day": 0, "features": [
    {"name": "PROT_01", "modality": "protein", "available_day": 0, "is_post_index": False},
    {"name": "RNA_001", "modality": "rna", "available_day": 0, "is_post_index": False},
    {"name": "late", "modality": "rna", "available_day": 30, "is_post_index": True},
]}


def _frame():
    return pd.DataFrame({
        "canonical_specimen_id": ["a", "b", "c", "d"], "subject_id": ["s1", "s2", "s3", "s4"],
        "PROT_01": [1.0, 3.0, np.nan, 100.0], "RNA_001": [2.0, 4.0, 6.0, 200.0], "late": [0.0, 0.0, 0.0, 0.0],
        "protein_available": [True, True, True, True], "rna_available": [True, True, False, True]})


def _members():
    return pd.DataFrame({"specimen_id": ["a", "b", "c", "d"], "subject_id": ["s1", "s2", "s3", "s4"],
                         "split": ["train", "train", "train", "test"]})


def test_post_index_feature_excluded_by_default():
    assert select_features(DICT, False) == ["PROT_01", "RNA_001"]
    assert select_features(DICT, True) == ["PROT_01", "RNA_001", "late"]


def test_fit_uses_train_rows_only():
    state = fit_preprocessor(_frame(), _members(), "train", ["PROT_01", "RNA_001"], ["protein", "rna"])
    assert state["median"][0] == 2.0  # median of the train values 1 and 3
    assert np.isclose(state["mean"][1], 3.0)  # train rows with RNA present: 2 and 4
    assert set(state["fit_membership"]["split"]) == {"train"}


def test_transform_zeroes_absent_modality():
    frame = _frame()
    state = fit_preprocessor(frame, _members(), "train", ["PROT_01", "RNA_001"], ["protein", "rna"])
    X, mask = transform(frame, state)
    assert X[2, 1] == 0.0 and mask[2].tolist() == [1.0, 0.0]
    assert X[2, 0] == (2.0 - state["mean"][0]) / state["scale"][0]  # imputed with the train median
