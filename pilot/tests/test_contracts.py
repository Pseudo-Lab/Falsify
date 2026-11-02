"""Frozen data contracts, checked against the committed data/ directory."""

from pathlib import Path

import pandas as pd

from tools.verify_contracts import Report, check_data

DATA = Path(__file__).resolve().parents[1] / "data"


def test_frozen_data_contracts_hold():
    rep = Report()
    check_data(DATA, rep)
    assert not rep.failed(), rep.failed()


def test_frozen_data_regenerates_byte_for_byte(tmp_path):
    import json

    from src.generate import write_cohort
    from src.io_utils import sha256_file

    frozen = json.loads((DATA / "generation_manifest.json").read_text(encoding="utf-8"))
    write_cohort(tmp_path, frozen["seed"])
    for name, digest in frozen["outputs"].items():
        assert sha256_file(tmp_path / name) == digest, name


def test_default_feature_set_excludes_the_post_index_feature():
    from src.io_utils import read_json
    from src.prepare import select_features

    fd = read_json(DATA / "feature_dictionary.json")
    default = select_features(fd, allow_post_index=False)
    assert len(default) == 119 and "followup_peak_synthetic" not in default
    assert len(select_features(fd, allow_post_index=True)) == 120


def test_default_split_keeps_subjects_apart():
    from src.split import assign_split, summarize

    specimens = pd.read_csv(DATA / "specimens.csv")
    summary = summarize(assign_split(specimens, "subject_id", [0.6, 0.2, 0.2], 1729)).set_index("split")
    assert summary["n_subjects"].to_dict() == {"train": 720, "val": 240, "test": 240}
    assert summary["overlap_subjects"].sum() == 0


def test_cohort_size():
    assert len(pd.read_csv(DATA / "subjects.csv")) == 1200
    assert len(pd.read_csv(DATA / "specimens.csv")) == 2400
