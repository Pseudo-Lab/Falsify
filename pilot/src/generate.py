"""Deterministic synthetic cohort generator.

Educational fiction: every value is drawn from the random streams below. No
blood was drawn, no assay was run and no person is represented.

Structure: each subject has a latent state shared by its two aliquots taken at
the same index visit (day 0). Protein and RNA features are noisy functions of
that state plus a site batch offset and aliquot-level technical noise. Six
synthetic outcomes depend on the latent state and the site. One RNA-file
column, ``followup_peak_synthetic``, is a day-30 follow-up measurement that
tracks the outcomes; the feature dictionary marks it as post-index.

Usage: ``python -m src.generate --out data``
"""

import argparse
import platform
import zlib
from pathlib import Path

import numpy as np
import pandas as pd

from src import schema
from src.io_utils import sha256_file, write_csv, write_json
from src.labels import build_labels, observation_mask
from src.pairing import modality_mask

GENERATOR_VERSION = "1.0"
SEED = 1729

PARAMS = {
    "n_subjects": 1200,
    "n_aliquots": 2,
    "site_ids": list(schema.SITE_IDS),
    "site_probs": [0.40, 0.35, 0.25],
    "latent_dim": 4,
    "site_latent_shift_sd": 0.25,
    "n_protein": 24,
    "n_rna_baseline": 95,
    "protein": {"offset": 5.0, "loading_sd": 0.9, "subject_sd": 0.6, "batch_sd": 0.3, "technical_sd": 0.35},
    "rna": {"offset": 8.0, "n_informative": 30, "loading_sd": 0.7, "subject_sd": 0.8, "batch_sd": 0.4,
            "technical_sd": 0.5},
    "task_base_rates": [0.06, 0.10, 0.15, 0.22, 0.30, 0.40],
    "task_weight_sd": 0.8,
    "site_task_effect_sd": 0.3,
    "late_event_prob": 0.08,
    "late_event_day_range": [181, 400],
    "censor_prob": 0.12,
    "censor_day_range": [15, 179],
    "complete_followup_range": [180, 400],
    "post_index_feature": {"name": "followup_peak_synthetic", "available_day": 30, "per_event": 1.2,
                           "subject_sd": 0.6, "technical_sd": 0.3, "offset": 2.0},
    "subject_failure_prob": 0.06,
    "protein_missing_prob": 0.07,
    "rna_missing_prob": 0.07,
    "cell_missing_prob": 0.015,
}

PRODUCER_FILES = ["generate.py", "labels.py", "pairing.py", "schema.py", "io_utils.py"]

PROTEIN_FEATURES = [f"PROT_{i:02d}" for i in range(1, 25)]
RNA_BASELINE_FEATURES = [f"RNA_{i:03d}" for i in range(1, 96)]
POST_INDEX_FEATURE = PARAMS["post_index_feature"]["name"]
RNA_FEATURES = RNA_BASELINE_FEATURES + [POST_INDEX_FEATURE]


def stream(name: str, seed: int = SEED) -> np.random.Generator:
    """Independent named random stream; adding a stream never shifts another."""
    return np.random.default_rng(np.random.SeedSequence([seed, zlib.crc32(name.encode())]))


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def _logit(p):
    return np.log(p / (1.0 - p))


def generate_cohort(seed: int = SEED) -> dict:
    p = PARAMS
    n = p["n_subjects"]
    subject_ids = [f"SYN-P{i:04d}" for i in range(1, n + 1)]

    rng = stream("sites", seed)
    site_idx = rng.choice(len(p["site_ids"]), size=n, p=p["site_probs"])
    sites = np.array(p["site_ids"])[site_idx]

    rng = stream("latent", seed)
    site_shift = rng.normal(0.0, p["site_latent_shift_sd"], size=(len(p["site_ids"]), p["latent_dim"]))
    latent = rng.normal(0.0, 1.0, size=(n, p["latent_dim"])) + site_shift[site_idx]

    # follow-up: most subjects complete 180 days, a fraction is censored earlier
    rng = stream("followup", seed)
    censored = rng.random(n) < p["censor_prob"]
    lo, hi = p["censor_day_range"]
    clo, chi = p["complete_followup_range"]
    followup_end = np.where(censored, rng.integers(lo, hi + 1, size=n), rng.integers(clo, chi + 1, size=n))

    subjects = pd.DataFrame({
        "subject_id": subject_ids,
        "site_id": sites,
        "index_day": 0,
        "followup_end_day": followup_end.astype(int),
    })

    # outcomes: true event day per (subject, task); only events seen during follow-up are recorded
    rng = stream("outcomes", seed)
    n_tasks = len(schema.TASK_IDS)
    weights = rng.normal(0.0, p["task_weight_sd"], size=(n_tasks, p["latent_dim"]))
    site_effect = rng.normal(0.0, p["site_task_effect_sd"], size=(len(p["site_ids"]), n_tasks))
    intercept = _logit(np.array(p["task_base_rates"]))
    risk = _sigmoid(intercept[None, :] + latent @ weights.T + site_effect[site_idx])
    has_event = rng.random((n, n_tasks)) < risk
    early_day = rng.integers(1, schema.HORIZON_DAYS + 1, size=(n, n_tasks))
    late = rng.random((n, n_tasks)) < p["late_event_prob"]
    llo, lhi = p["late_event_day_range"]
    late_day = rng.integers(llo, lhi + 1, size=(n, n_tasks))
    true_day = np.where(has_event, early_day, np.where(late, late_day, -1))
    seen = (true_day > 0) & (true_day <= followup_end[:, None])

    event_rows = []
    for i, sid in enumerate(subject_ids):
        for t, task in enumerate(schema.TASK_IDS):
            event_rows.append((sid, task, int(true_day[i, t]) if seen[i, t] else None, int(followup_end[i])))
    events = pd.DataFrame(event_rows, columns=["subject_id", "task_id", "event_day", "followup_end_day"])
    events["event_day"] = events["event_day"].astype("Int64")
    labels = build_labels(events)

    # specimens: two aliquots per subject from the same index visit
    specimen_rows = []
    for sid in subject_ids:
        for a in range(1, p["n_aliquots"] + 1):
            specimen_rows.append((f"{sid}-A{a}", sid, a, 0))
    specimens = pd.DataFrame(specimen_rows, columns=["specimen_id", "subject_id", "aliquot_index", "collection_day"])
    spec_subject_idx = np.repeat(np.arange(n), p["n_aliquots"])
    n_spec = len(specimens)

    # protein features
    rng = stream("protein", seed)
    pp = p["protein"]
    load = rng.normal(0.0, pp["loading_sd"], size=(p["n_protein"], p["latent_dim"]))
    subj = rng.normal(0.0, pp["subject_sd"], size=(n, p["n_protein"]))
    batch = rng.normal(0.0, pp["batch_sd"], size=(len(p["site_ids"]), p["n_protein"]))
    tech = rng.normal(0.0, pp["technical_sd"], size=(n_spec, p["n_protein"]))
    protein = (pp["offset"] + latent @ load.T + subj + batch[site_idx])[spec_subject_idx] + tech

    # RNA baseline features: a subset carries signal, the rest is noise
    rng = stream("rna", seed)
    rp = p["rna"]
    load = np.zeros((p["n_rna_baseline"], p["latent_dim"]))
    informative = rng.choice(p["n_rna_baseline"], size=rp["n_informative"], replace=False)
    load[informative] = rng.normal(0.0, rp["loading_sd"], size=(rp["n_informative"], p["latent_dim"]))
    subj = rng.normal(0.0, rp["subject_sd"], size=(n, p["n_rna_baseline"]))
    batch = rng.normal(0.0, rp["batch_sd"], size=(len(p["site_ids"]), p["n_rna_baseline"]))
    tech = rng.normal(0.0, rp["technical_sd"], size=(n_spec, p["n_rna_baseline"]))
    rna = (rp["offset"] + latent @ load.T + subj + batch[site_idx])[spec_subject_idx] + tech

    # day-30 follow-up measurement tracking 180-day outcomes (post-index)
    rng = stream("post_index", seed)
    pi = p["post_index_feature"]
    in_window = ((true_day > 0) & (true_day <= schema.HORIZON_DAYS)).sum(axis=1)
    subj_peak = pi["offset"] + pi["per_event"] * in_window + rng.normal(0.0, pi["subject_sd"], size=n)
    peak = subj_peak[spec_subject_idx] + rng.normal(0.0, pi["technical_sd"], size=n_spec)
    rna = np.column_stack([rna, peak])

    # missingness: whole-subject processing failures, per-specimen modality loss, sporadic cells
    rng = stream("missingness", seed)
    failed = (rng.random(n) < p["subject_failure_prob"])[spec_subject_idx]
    protein_ok = ~failed & (rng.random(n_spec) >= p["protein_missing_prob"])
    rna_ok = ~failed & (rng.random(n_spec) >= p["rna_missing_prob"])
    protein[rng.random(protein.shape) < p["cell_missing_prob"]] = np.nan
    rna[rng.random(rna.shape) < p["cell_missing_prob"]] = np.nan

    # local identifiers and independent row orders per modality file
    rng = stream("local_ids", seed)
    p_codes = rng.choice(np.arange(10000, 100000), size=n_spec, replace=False)
    r_codes = rng.choice(np.arange(10000, 100000), size=n_spec, replace=False)
    protein_local = np.array([f"PL-{c}" for c in p_codes])
    rna_local = np.array([f"RL-{c}" for c in r_codes])
    crosswalk = pd.DataFrame({
        "canonical_specimen_id": specimens["specimen_id"],
        "protein_local_id": np.where(protein_ok, protein_local, None),
        "rna_local_id": np.where(rna_ok, rna_local, None),
    })

    protein_df = pd.DataFrame(np.round(protein, 6), columns=PROTEIN_FEATURES)
    protein_df.insert(0, "protein_local_id", protein_local)
    protein_df = protein_df[protein_ok].iloc[rng.permutation(int(protein_ok.sum()))].reset_index(drop=True)
    rna_df = pd.DataFrame(np.round(rna, 6), columns=RNA_FEATURES)
    rna_df.insert(0, "rna_local_id", rna_local)
    rna_df = rna_df[rna_ok].iloc[rng.permutation(int(rna_ok.sum()))].reset_index(drop=True)

    return {
        "subjects": subjects,
        "specimens": specimens,
        "protein": protein_df,
        "rna": rna_df,
        "modality_crosswalk": crosswalk,
        "labels": labels,
    }


def feature_dictionary() -> dict:
    features = []
    for name in PROTEIN_FEATURES:
        features.append({
            "name": name, "modality": "protein", "available_day": 0, "is_post_index": False,
            "role": "baseline_synthetic",
            "description": "Synthetic proteoform-level abundance proxy measured at the index visit "
                           "(simulated value; no assay was performed).",
        })
    for name in RNA_BASELINE_FEATURES:
        features.append({
            "name": name, "modality": "rna", "available_day": 0, "is_post_index": False,
            "role": "baseline_synthetic",
            "description": "Synthetic transcript abundance proxy measured at the index visit "
                           "(simulated value; no assay was performed).",
        })
    pi = PARAMS["post_index_feature"]
    features.append({
        "name": pi["name"], "modality": "rna", "available_day": pi["available_day"], "is_post_index": True,
        "role": "post_index_label_proxy",
        "description": "Synthetic follow-up measurement taken on day 30 after the index visit; it tracks "
                       "events inside the 180-day window and is not available at prediction time (day 0).",
    })
    return {
        "schema_version": "1.0",
        "prediction_time_day": 0,
        "terminology": {
            "proteoform": "Distinct molecular form of a protein product of a single gene "
                          "(Smith & Kelleher, Nature Methods 10:186-187, 2013, doi:10.1038/nmeth.2369). "
                          "Used here only as the name of a simulated feature family."
        },
        "features": features,
    }


def label_dictionary() -> dict:
    return {
        "schema_version": "1.0",
        "horizon_days": schema.HORIZON_DAYS,
        "index_day": 0,
        "tasks": [
            {"task_id": t, "description": f"Synthetic binary outcome {t} within 180 days after the index visit. "
                                          "Abstract simulated event; not a disease or clinical diagnosis."}
            for t in schema.TASK_IDS
        ],
        "values": {"y": "1 = event observed in (0, 180]; 0 = no event in (0, 180] and follow-up reached day 180 "
                        "(events recorded after day 180 do not count); null = follow-up ended before day 180 "
                        "without an event (not observed)",
                   "observed": "false exactly when y is null"},
    }


def label_provenance(labels: pd.DataFrame) -> dict:
    per_task = {}
    for task, grp in labels.groupby("task_id"):
        per_task[task] = {
            "n_subjects": int(len(grp)),
            "n_observed": int(grp["observed"].sum()),
            "n_unobserved": int((~grp["observed"]).sum()),
            "n_positive": int((grp["y"] == 1).sum()),
            "n_negative": int((grp["y"] == 0).sum()),
        }
    return {
        "schema_version": "1.0",
        "builder": "src/labels.py::build_labels",
        "horizon_days": schema.HORIZON_DAYS,
        "inputs": ["event_day", "followup_end_day"],
        "rules": [
            "observed event with 0 < event_day <= 180 -> y=1, observed=true",
            "otherwise followup_end_day >= 180 -> y=0, observed=true",
            "otherwise -> y=null, observed=false (right-censored before day 180)",
        ],
        "per_task": per_task,
    }


def write_cohort(out_dir, seed: int = SEED) -> dict:
    out_dir = Path(out_dir)
    tables = generate_cohort(seed)
    write_csv(tables["subjects"], out_dir / "subjects.csv")
    write_csv(tables["specimens"], out_dir / "specimens.csv")
    write_csv(tables["modality_crosswalk"], out_dir / "modality_crosswalk.csv")
    write_csv(tables["protein"], out_dir / "protein.csv")
    write_csv(tables["rna"], out_dir / "rna.csv")
    write_csv(tables["labels"], out_dir / "labels.csv")
    write_csv(observation_mask(tables["labels"]), out_dir / "observation_mask.csv")
    write_csv(modality_mask(tables["modality_crosswalk"]), out_dir / "modality_mask.csv")
    write_json(feature_dictionary(), out_dir / "feature_dictionary.json")
    write_json(label_dictionary(), out_dir / "label_dictionary.json")
    write_json(label_provenance(tables["labels"]), out_dir / "label_provenance.json")

    outputs = ["subjects.csv", "specimens.csv", "modality_crosswalk.csv", "protein.csv", "rna.csv",
               "labels.csv", "observation_mask.csv", "modality_mask.csv", "feature_dictionary.json",
               "label_dictionary.json", "label_provenance.json"]
    manifest = {
        "schema_version": "1.0",
        "generator": "src/generate.py",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "synthetic_only": True,
        "wet_lab_assay_performed": False,
        "human_participants": False,
        "parameters": PARAMS,
        "counts": {
            "subjects": int(len(tables["subjects"])),
            "specimens": int(len(tables["specimens"])),
            "protein_rows": int(len(tables["protein"])),
            "rna_rows": int(len(tables["rna"])),
            "features": len(PROTEIN_FEATURES) + len(RNA_FEATURES),
            "tasks": len(schema.TASK_IDS),
        },
        "outputs": {name: sha256_file(out_dir / name) for name in outputs},
        "producer": {
            "source_sha256": {f"src/{name}": sha256_file(Path(__file__).parent / name) for name in PRODUCER_FILES
                              if (Path(__file__).parent / name).exists()},
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
    }
    write_json(manifest, out_dir / "generation_manifest.json")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="data")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args(argv)
    manifest = write_cohort(args.out, args.seed)
    print(f"wrote {manifest['counts']} to {args.out}")


if __name__ == "__main__":
    main()
