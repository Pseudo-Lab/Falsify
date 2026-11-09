import pandas as pd
import pytest

from examples.paired_preview import build_preview
from src.pairing import assemble, validate_crosswalk


def _toy():
    specimens = pd.DataFrame({"specimen_id": ["SYN-P0001-A1", "SYN-P0001-A2", "SYN-P0002-A1"],
                              "subject_id": ["SYN-P0001", "SYN-P0001", "SYN-P0002"], "aliquot_index": [1, 2, 1]})
    crosswalk = pd.DataFrame({"canonical_specimen_id": specimens["specimen_id"],
                              "protein_local_id": ["PL-1", "PL-2", None], "rna_local_id": ["RL-9", "RL-8", "RL-7"]})
    protein = pd.DataFrame({"protein_local_id": ["PL-2", "PL-1"], "PROT_01": [2.0, 1.0], "PROT_02": [20.0, 10.0]})
    rna = pd.DataFrame({"rna_local_id": ["RL-7", "RL-9", "RL-8"], "RNA_001": [7.0, 9.0, 8.0],
                        "RNA_002": [0.7, 0.9, 0.8]})
    return specimens, crosswalk, protein, rna


def test_join_uses_canonical_ids_not_row_order():
    specimens, crosswalk, protein, rna = _toy()
    a = assemble(protein, rna, crosswalk, specimens)
    b = assemble(protein.iloc[::-1], rna.sample(frac=1, random_state=3), crosswalk, specimens)
    pd.testing.assert_frame_equal(a, b)
    row = a.set_index("canonical_specimen_id").loc["SYN-P0001-A1"]
    assert row["PROT_01"] == 1.0 and row["RNA_001"] == 9.0


def test_missing_modality_is_flagged():
    specimens, crosswalk, protein, rna = _toy()
    a = assemble(protein, rna, crosswalk, specimens).set_index("canonical_specimen_id")
    assert not a.loc["SYN-P0002-A1", "protein_available"]
    assert a.loc["SYN-P0002-A1", "rna_available"]


def test_duplicate_local_id_is_rejected():
    _, crosswalk, _, _ = _toy()
    crosswalk.loc[1, "rna_local_id"] = "RL-9"
    with pytest.raises(ValueError):
        validate_crosswalk(crosswalk)


def test_preview_rows_share_one_canonical_id():
    _, crosswalk, protein, rna = _toy()
    preview = build_preview(protein, rna, crosswalk)
    assert len(preview) == 2
    assert (preview["protein_canonical_specimen_id"] == preview["rna_canonical_specimen_id"]).all()
