"""Pair protein and RNA measurements through the canonical specimen identifier.

Each modality file carries its own local identifier and its own row order. The
crosswalk maps both local identifiers to ``canonical_specimen_id``; rows are
joined on that key only (one-to-one), never by position.
"""

import pandas as pd


def validate_crosswalk(crosswalk: pd.DataFrame, specimens: pd.DataFrame = None) -> None:
    """Every canonical specimen appears once and every local id maps to one specimen.

    With ``specimens``, the crosswalk must list exactly the known specimens.
    """
    if crosswalk["canonical_specimen_id"].duplicated().any():
        raise ValueError("crosswalk: duplicated canonical_specimen_id")
    if specimens is not None and set(crosswalk["canonical_specimen_id"]) != set(specimens["specimen_id"]):
        raise ValueError("crosswalk: canonical ids differ from specimens.csv")
    for col in ("protein_local_id", "rna_local_id"):
        present = crosswalk[col].dropna()
        if present.duplicated().any():
            raise ValueError(f"crosswalk: {col} maps to more than one specimen")


def _attach_canonical(table: pd.DataFrame, crosswalk: pd.DataFrame, local_col: str, prefix: str) -> pd.DataFrame:
    keyed = crosswalk[["canonical_specimen_id", local_col]].dropna(subset=[local_col])
    merged = table.merge(keyed, on=local_col, how="left", validate="one_to_one")
    if merged["canonical_specimen_id"].isna().any():
        raise ValueError(f"{prefix}: rows without a crosswalk entry")
    merged = merged.rename(columns={"canonical_specimen_id": f"{prefix}_canonical_specimen_id"})
    merged["canonical_specimen_id"] = merged[f"{prefix}_canonical_specimen_id"]
    return merged


def assemble(protein: pd.DataFrame, rna: pd.DataFrame, crosswalk: pd.DataFrame,
             specimens: pd.DataFrame) -> pd.DataFrame:
    """Return one row per specimen with both modalities joined on the canonical id.

    Specimens lacking a modality keep NaN features for it; both canonical ids
    are retained so the join can be audited row by row.
    """
    validate_crosswalk(crosswalk, specimens)
    prot = _attach_canonical(protein, crosswalk, "protein_local_id", "protein")
    rn = _attach_canonical(rna, crosswalk, "rna_local_id", "rna")
    base = specimens[["specimen_id", "subject_id", "aliquot_index"]].rename(
        columns={"specimen_id": "canonical_specimen_id"})
    out = base.merge(prot, on="canonical_specimen_id", how="left", validate="one_to_one")
    out = out.merge(rn, on="canonical_specimen_id", how="left", validate="one_to_one")
    for side, table in (("protein", prot), ("rna", rn)):
        if out[f"{side}_canonical_specimen_id"].notna().sum() != len(table):
            raise ValueError(f"pairing: some {side} rows did not attach to a specimen")
    out["protein_available"] = out["protein_canonical_specimen_id"].notna()
    out["rna_available"] = out["rna_canonical_specimen_id"].notna()
    return out.sort_values("canonical_specimen_id").reset_index(drop=True)


def modality_mask(crosswalk: pd.DataFrame) -> pd.DataFrame:
    """Per-specimen modality availability (independent of label observation)."""
    out = pd.DataFrame({
        "specimen_id": crosswalk["canonical_specimen_id"],
        "protein_available": crosswalk["protein_local_id"].notna(),
        "rna_available": crosswalk["rna_local_id"].notna(),
    })
    return out.sort_values("specimen_id").reset_index(drop=True)


def score_status(protein_available, rna_available):
    """A specimen can be scored when at least one modality is present; otherwise abstain."""
    return "scored" if (protein_available or rna_available) else "abstain"
