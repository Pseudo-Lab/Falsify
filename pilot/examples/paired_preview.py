"""Write a small preview of paired protein and RNA rows.

Each modality is mapped to ``canonical_specimen_id`` through the crosswalk and
the two tables are merged on that key (one-to-one). Both sides' canonical ids
are kept in the output so every row can be checked.

Usage: ``python -m examples.paired_preview``
"""

import argparse
from pathlib import Path

import pandas as pd

from src.io_utils import read_csv, write_csv

PREVIEW_COLUMNS = {"protein": ["PROT_01", "PROT_02"], "rna": ["RNA_001", "RNA_002"]}


def build_preview(protein: pd.DataFrame, rna: pd.DataFrame, crosswalk: pd.DataFrame, n_rows: int = 12) -> pd.DataFrame:
    prot = protein.merge(crosswalk[["canonical_specimen_id", "protein_local_id"]].dropna(),
                         on="protein_local_id", validate="one_to_one")
    prot["protein_canonical_specimen_id"] = prot["canonical_specimen_id"]
    rn = rna.merge(crosswalk[["canonical_specimen_id", "rna_local_id"]].dropna(),
                   on="rna_local_id", validate="one_to_one")
    rn["rna_canonical_specimen_id"] = rn["canonical_specimen_id"]
    prot = prot[["canonical_specimen_id", "protein_canonical_specimen_id", "protein_local_id", *PREVIEW_COLUMNS["protein"]]]
    rn = rn[["canonical_specimen_id", "rna_canonical_specimen_id", "rna_local_id", *PREVIEW_COLUMNS["rna"]]]
    rn = rn.sample(frac=1, random_state=1729).reset_index(drop=True)
    paired = pd.concat([prot.reset_index(drop=True),
                        rn.drop(columns=["canonical_specimen_id"]).reset_index(drop=True)], axis=1)
    paired = paired.sort_values("canonical_specimen_id").head(n_rows).reset_index(drop=True)
    return paired.drop(columns=["canonical_specimen_id"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Paired protein/RNA preview.")
    parser.add_argument("--data", default="data")
    parser.add_argument("--rows", type=int, default=12)
    args = parser.parse_args(argv)
    data = Path(args.data)
    preview = build_preview(read_csv(data / "protein.csv"), read_csv(data / "rna.csv"),
                            read_csv(data / "modality_crosswalk.csv"), args.rows)
    write_csv(preview, data / "pairing_preview.csv")
    print(preview.to_string(index=False))


if __name__ == "__main__":
    main()
