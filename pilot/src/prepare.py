"""Feature selection, median imputation and standard scaling.

Statistics are fitted on the specimens named by ``fit_scope`` and then applied
unchanged to every split. Loading the whole table, or transforming the test
split with already-fitted statistics, does not change what the fit used; the
fit membership is returned so it can be checked.

A modality that is absent for a specimen is not imputed: its block is set to
zeros and the modality mask carries the absence to the model.
"""

import numpy as np
import pandas as pd

FIT_SCOPES = {"train": ("train",), "all": ("train", "val", "test")}


def select_features(feature_dictionary: dict, allow_post_index: bool) -> list:
    """Names of usable features, in dictionary order.

    A feature is usable at prediction time when its ``available_day`` is not
    later than the dictionary's ``prediction_time_day``.
    """
    day0 = feature_dictionary.get("prediction_time_day", 0)
    chosen = []
    for feat in feature_dictionary["features"]:
        if allow_post_index or feat["available_day"] <= day0:
            chosen.append(feat["name"])
    return chosen


def feature_modalities(feature_dictionary: dict, features) -> list:
    lookup = {f["name"]: f["modality"] for f in feature_dictionary["features"]}
    return [lookup[f] for f in features]


def fit_preprocessor(frame: pd.DataFrame, members: pd.DataFrame, fit_scope: str, features, modalities) -> dict:
    """Fit per-feature median and mean/std on the specimens selected by ``fit_scope``.

    ``frame`` holds one row per specimen (column ``canonical_specimen_id``) with
    feature columns and ``protein_available``/``rna_available``. Statistics of a
    feature use the selected specimens where its modality is present; the
    returned fit membership marks, per specimen, which modality blocks were used.
    """
    if fit_scope not in FIT_SCOPES:
        raise ValueError(f"unknown fit_scope {fit_scope!r}")
    split_of = members.set_index("specimen_id")["split"]
    in_fit = frame["canonical_specimen_id"].map(split_of).isin(FIT_SCOPES[fit_scope]).to_numpy()
    medians, means, scales, n_used = [], [], [], []
    for feat, mod in zip(features, modalities):
        avail = frame[f"{mod}_available"].to_numpy(dtype=bool)
        values = frame.loc[in_fit & avail, feat].to_numpy(dtype=float)
        med = float(np.nanmedian(values))
        filled = np.where(np.isnan(values), med, values)
        mean = float(filled.mean())
        std = float(filled.std())
        medians.append(med)
        means.append(mean)
        scales.append(std if std > 0 else 1.0)
        n_used.append(int(len(values)))
    fit_rows = frame.loc[in_fit, ["canonical_specimen_id", "subject_id", "protein_available", "rna_available"]]
    fit_rows = fit_rows.rename(columns={"canonical_specimen_id": "specimen_id", "protein_available": "protein_used",
                                        "rna_available": "rna_used"})
    fit_rows = fit_rows.merge(members[["specimen_id", "split"]], on="specimen_id", how="left")
    fit_rows = fit_rows[["specimen_id", "subject_id", "split", "protein_used", "rna_used"]]
    return {
        "fit_scope": fit_scope,
        "features": list(features),
        "modalities": list(modalities),
        "median": np.array(medians),
        "mean": np.array(means),
        "scale": np.array(scales),
        "n_rows_used": np.array(n_used),
        "fit_membership": fit_rows.sort_values("specimen_id").reset_index(drop=True),
    }


def transform(frame: pd.DataFrame, state: dict):
    """Apply fitted statistics. Returns (X, modality_mask) as float arrays."""
    features, modalities = state["features"], state["modalities"]
    X = frame[features].to_numpy(dtype=float)
    X = np.where(np.isnan(X), state["median"][None, :], X)
    X = (X - state["mean"][None, :]) / state["scale"][None, :]
    mods = np.array(modalities)
    mask = np.column_stack([frame["protein_available"].to_numpy(bool), frame["rna_available"].to_numpy(bool)])
    absent = np.zeros_like(X, dtype=bool)
    absent[:, mods == "protein"] = ~mask[:, [0]]
    absent[:, mods == "rna"] = ~mask[:, [1]]
    X[absent] = 0.0
    return X, mask.astype(float)


def save_state(state: dict, path, provenance: dict) -> None:
    """Store fitted statistics with the split and membership they came from."""
    np.savez(
        path,
        split_id=np.array(provenance["split_id"]),
        split_members_sha256=np.array(provenance["split_members_sha256"]),
        fit_membership_sha256=np.array(provenance["fit_membership_sha256"]),
        features=np.array(state["features"]),
        modalities=np.array(state["modalities"]),
        median=state["median"],
        mean=state["mean"],
        scale=state["scale"],
        n_rows_used=state["n_rows_used"],
        fit_scope=np.array(state["fit_scope"]),
    )
