"""Check frozen data contracts and run-capsule integrity.

Usage:
  ``python -m tools.verify_contracts``                 data contracts only
  ``python -m tools.verify_contracts --run <run_id>``  plus capsule integrity

Data checks cover identifiers, foreign keys, the one-to-one crosswalk, the
feature dictionary, label rules recomputed from event and follow-up days, and
the separation of observation and modality masks. Capsule checks confirm that
recorded hashes match the stored files and the committed source. They do not
judge whether a run's settings follow the analysis protocol.
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

import pandas as pd

SUBJECT = re.compile(r"^SYN-P\d{4}$")
SPECIMEN = re.compile(r"^(SYN-P\d{4})-A([12])$")
TASKS = [f"SYN_T{i:02d}" for i in range(1, 7)]
HORIZON = 180
RUN_FILES = ["launch.json", "source_index.json", "run_manifest.json", "inputs.json", "metrics.json",
             "selection.json",
             "predictions.csv", "flow.csv", "fit_membership.csv", "epoch_metrics.csv", "events.jsonl",
             "checkpoint_index.jsonl", "source.tar", "checkpoint.npz", "preprocess_state.npz",
             ".hydra/config.yaml", ".hydra/hydra.yaml", ".hydra/overrides.yaml"]


def sha256_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    df = pd.read_csv(path, keep_default_na=False, na_values=[""], dtype=str)
    return df


def as_bool(series):
    mapped = series.str.lower().map({"true": True, "false": False})
    if mapped.isna().any():
        raise ValueError("non-boolean value")
    return mapped.astype(bool)


class Report:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, detail=""):
        self.rows.append((name, "PASS" if ok else "FAIL", detail))

    def skip(self, name, detail=""):
        self.rows.append((name, "SKIP", detail))

    def failed(self):
        return [r for r in self.rows if r[1] == "FAIL"]

    def print(self):
        for name, state, detail in self.rows:
            print(f"{state}  {name}" + (f"  ({detail})" if detail else ""))


def check_data(data: Path, rep: Report) -> None:
    subjects = read(data / "subjects.csv")
    specimens = read(data / "specimens.csv")
    cross = read(data / "modality_crosswalk.csv")
    protein = read(data / "protein.csv")
    rna = read(data / "rna.csv")
    labels = read(data / "labels.csv")
    obs = read(data / "observation_mask.csv")
    mod = read(data / "modality_mask.csv")
    fdict = json.loads((data / "feature_dictionary.json").read_text(encoding="utf-8"))

    rep.check("subjects: unique well-formed subject_id",
              subjects["subject_id"].is_unique and subjects["subject_id"].str.match(SUBJECT).all(),
              f"n={len(subjects)}")
    parent = specimens["specimen_id"].str.extract(SPECIMEN)
    rep.check("specimens: unique well-formed specimen_id", specimens["specimen_id"].is_unique and parent[0].notna().all(),
              f"n={len(specimens)}")
    rep.check("specimens: parent subject matches subject_id column", (parent[0] == specimens["subject_id"]).all())
    rep.check("specimens: aliquot_index matches identifier", (parent[1] == specimens["aliquot_index"]).all())
    rep.check("specimens: every subject_id exists in subjects",
              specimens["subject_id"].isin(subjects["subject_id"]).all())

    rep.check("crosswalk: one row per specimen", cross["canonical_specimen_id"].is_unique and
              set(cross["canonical_specimen_id"]) == set(specimens["specimen_id"]))
    for col, table in (("protein_local_id", protein), ("rna_local_id", rna)):
        mapped = cross[col].dropna()
        rep.check(f"crosswalk: {col} unique", mapped.is_unique)
        rep.check(f"crosswalk: {col} covers the modality file exactly",
                  set(mapped) == set(table[col]) and table[col].is_unique)

    names = {f["name"]: f for f in fdict["features"]}
    prot_cols = [c for c in protein.columns if c != "protein_local_id"]
    rna_cols = [c for c in rna.columns if c != "rna_local_id"]
    rep.check("features: file columns match the dictionary", set(prot_cols) | set(rna_cols) == set(names))
    rep.check("features: dictionary modality matches file",
              all(names[c]["modality"] == "protein" for c in prot_cols) and
              all(names[c]["modality"] == "rna" for c in rna_cols))
    rep.check("features: availability recorded for every feature",
              all("available_day" in f and "is_post_index" in f for f in fdict["features"]))
    rep.check("features: is_post_index agrees with available_day",
              all(f["is_post_index"] == (f["available_day"] > fdict.get("prediction_time_day", 0))
                  for f in fdict["features"]))
    post = [f["name"] for f in fdict["features"] if f["is_post_index"]]
    rep.check("features: 24 protein and 96 RNA columns", len(prot_cols) == 24 and len(rna_cols) == 96,
              f"protein={len(prot_cols)} rna={len(rna_cols)}")
    rep.check("features: post-index features listed in the dictionary", post == ["followup_peak_synthetic"],
              f"post-index={post}; usable at day 0={len(names) - len(post)}")
    late = names.get("followup_peak_synthetic", {})
    rep.check("features: followup_peak_synthetic is a day-30 label proxy, all others are day-0",
              late.get("available_day") == 30 and late.get("role") == "post_index_label_proxy" and
              all(f["available_day"] == 0 for n, f in names.items() if n != "followup_peak_synthetic"))

    rep.check("labels: one row per (subject, task)",
              not labels.duplicated(["subject_id", "task_id"]).any() and
              len(labels) == len(subjects) * len(TASKS) and set(labels["task_id"]) == set(TASKS))
    observed = as_bool(labels["observed"])
    y = pd.to_numeric(labels["y"])
    rep.check("labels: observed is false exactly when y is null", ((y.isna()) == (~observed)).all())
    rep.check("labels: y in {0,1}", y.dropna().isin([0, 1]).all())
    fu = subjects.set_index("subject_id")["followup_end_day"].astype(int)
    rep.check("labels: followup_end_day matches subjects",
              (labels["followup_end_day"].astype(int).to_numpy() == fu.loc[labels["subject_id"]].to_numpy()).all())
    ev = pd.to_numeric(labels["event_day"])
    fol = labels["followup_end_day"].astype(int)
    rep.check("labels: recorded events fall within follow-up", (ev.dropna() <= fol[ev.notna()]).all())
    pos = ev.notna() & (ev > 0) & (ev <= HORIZON)
    exp_y = pd.Series(pd.NA, index=labels.index, dtype="Float64")
    exp_y[pos] = 1
    exp_y[~pos & (fol >= HORIZON)] = 0
    agree = (exp_y.isna() == y.isna()) & ((exp_y.fillna(-1) == y.fillna(-1)))
    rep.check("labels: y recomputed from event_day and followup_end_day", agree.all(),
              f"{int((~agree).sum())} disagreements")
    merged = labels[["subject_id", "task_id"]].assign(obs=observed).merge(
        obs.assign(mask=as_bool(obs["observed"]))[["subject_id", "task_id", "mask"]], on=["subject_id", "task_id"])
    rep.check("observation_mask: equals labels.observed", len(merged) == len(labels) and (merged.obs == merged["mask"]).all())
    mm = mod.set_index("specimen_id")
    cw = cross.set_index("canonical_specimen_id")
    rep.check("modality_mask: equals crosswalk presence",
              set(mm.index) == set(cw.index) and
              (as_bool(mm["protein_available"]) == cw.loc[mm.index, "protein_local_id"].notna()).all() and
              (as_bool(mm["rna_available"]) == cw.loc[mm.index, "rna_local_id"].notna()).all())
    rep.check("masks: observation and modality masks are separate tables",
              "observed" not in mod.columns and not {"protein_available", "rna_available"} & set(obs.columns))
    p_av, r_av = as_bool(mod["protein_available"]), as_bool(mod["rna_available"])
    none = mod.assign(none=~p_av & ~r_av, subject=mod["specimen_id"].str[:9]).groupby("subject")["none"].all()
    rep.check("fixture: cohort contains unobserved labels, one-modality specimens and abstaining subjects",
              (~observed).any() and (p_av ^ r_av).any() and none.any(),
              f"unobserved={int((~observed).sum())} one-modality={int((p_av ^ r_av).sum())} "
              f"abstaining subjects={int(none.sum())}")

    manifest = json.loads((data / "generation_manifest.json").read_text(encoding="utf-8"))
    bad = [n for n, h in manifest["outputs"].items() if sha256_file(data / n) != h]
    rep.check("generation_manifest: output hashes match files", not bad, ", ".join(bad))
    producer = manifest.get("producer", {}).get("source_sha256", {})
    root = data.resolve().parent
    stale = [p for p, h in producer.items() if not (root / p).exists() or sha256_file(root / p) != h]
    rep.check("generation_manifest: producer source hashes match the current code", producer and not stale,
              ", ".join(stale))


def git_available() -> bool:
    try:
        subprocess.run(["git", "rev-parse", "--git-dir"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def git(*args):
    return subprocess.run(["git", "-c", "core.autocrlf=false", *args], capture_output=True, check=True).stdout


def tar_members(data: bytes) -> dict:
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        return {m.name: hashlib.sha256(tar.extractfile(m).read()).hexdigest() for m in tar.getmembers() if m.isfile()}


def params_sha256(npz_path: Path) -> str:
    """Same parameter hash as recorded per epoch: sorted names, then raw float32 bytes."""
    import numpy as np
    h = hashlib.sha256()
    with np.load(npz_path) as arrays:
        for name in sorted(arrays.files):
            h.update(name.encode())
            h.update(np.ascontiguousarray(arrays[name]).tobytes())
    return h.hexdigest()


def check_run(run_dir: Path, rep: Report, data: Path) -> str:
    """Integrity of one capsule. Returns its recorded source commit (or None)."""
    tag = run_dir.name
    missing = [f for f in RUN_FILES if not (run_dir / f).exists()]
    rep.check(f"{tag}: required capsule files present", not missing, ", ".join(missing))
    if missing:
        return None
    manifest = json.loads((run_dir / "run_manifest.json").read_text(encoding="utf-8"))
    launch = json.loads((run_dir / "launch.json").read_text(encoding="utf-8"))
    sindex = json.loads((run_dir / "source_index.json").read_text(encoding="utf-8"))
    inputs = json.loads((run_dir / "inputs.json").read_text(encoding="utf-8"))
    listed = manifest["outputs"]
    absent = [n for n in listed if not (run_dir / n).exists()]
    bad = [n for n in listed if n not in absent and sha256_file(run_dir / n) != listed[n]]
    extra = [p.relative_to(run_dir).as_posix() for p in run_dir.rglob("*") if p.is_file()
             and p.relative_to(run_dir).as_posix() not in listed and p.name != "run_manifest.json"]
    rep.check(f"{tag}: run_manifest output hashes match files", not (absent or bad or extra),
              f"missing={absent[:3]} changed={bad[:3]} unlisted={extra[:3]}")
    rep.check(f"{tag}: exit code 0", manifest["exit_code"] == 0)
    import yaml
    stored_cfg = yaml.safe_load((run_dir / ".hydra" / "config.yaml").read_text(encoding="utf-8"))
    canonical = hashlib.sha256(json.dumps(stored_cfg, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    rep.check(f"{tag}: effective config hash matches the stored .hydra/config.yaml",
              manifest["effective_config_sha256"] == inputs.get("effective_config_sha256") == canonical and
              manifest["hydra_config_file_sha256"] == sha256_file(run_dir / ".hydra" / "config.yaml"))
    hydra_overrides = yaml.safe_load((run_dir / ".hydra" / "overrides.yaml").read_text(encoding="utf-8"))
    rep.check(f"{tag}: Hydra overrides equal the launched case overrides",
              [o for o in hydra_overrides if not o.startswith("run_id=")] == launch["overrides"] and
              f"run_id={tag}" in hydra_overrides)
    archive = (run_dir / "source.tar").read_bytes()
    rep.check(f"{tag}: source.tar hash matches source_index",
              hashlib.sha256(archive).hexdigest() == sindex["archive_sha256"])
    members = tar_members(archive)
    rep.check(f"{tag}: source.tar members match source_index files", members == sindex["files"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        comment = tar.pax_headers.get("comment")
        sched = tar.extractfile("schedule/cases.jsonl").read().decode("utf-8") if \
            "schedule/cases.jsonl" in tar.getnames() else ""
    case_lines = [json.loads(line) for line in sched.splitlines() if line.strip()]
    case = next((c for c in case_lines if c["case_id"] == tag), None)
    rep.check(f"{tag}: overrides match schedule/cases.jsonl inside source.tar",
              case is not None and case["overrides"] == launch["overrides"])
    commit = launch["source_commit"]
    rep.check(f"{tag}: launch, source_index, run_manifest and archive name the same commit",
              commit == sindex["source_commit"] == manifest["source_commit"] == comment)
    rep.check(f"{tag}: data fingerprint matches the current data files",
              inputs["data"]["files"] == {n: sha256_file(data / n) for n in inputs["data"]["files"]})
    split_members = Path("splits") / inputs["split_id"] / "members.csv"
    rep.check(f"{tag}: split members file matches the recorded hash",
              split_members.exists() and sha256_file(split_members) == inputs["split_members_sha256"])
    rep.check(f"{tag}: selected checkpoint parameters match the recorded hash",
              params_sha256(run_dir / "checkpoint.npz") == manifest["checkpoint_params_sha256"])
    pred = read(run_dir / "predictions.csv")
    rep.check(f"{tag}: predictions keyed by (run_id, specimen_id, task_id)",
              not pred.duplicated(["run_id", "specimen_id", "task_id"]).any() and (pred["run_id"] == tag).all())
    if git_available():
        try:
            rebuilt = git("archive", "--format=tar", commit, "--", *sindex["source_paths"])
            rep.check(f"{tag}: source.tar content reproduces from the recorded commit", tar_members(rebuilt) == members)
            in_tree = git("ls-tree", "-d", commit, "--", "runs").strip()
            rep.check(f"{tag}: recorded source commit contains no run outputs", not in_tree)
            added = git("log", "--diff-filter=A", "--format=%H", "--", f"{run_dir.as_posix()}/run_manifest.json")
            added = added.decode().split()
            if added:
                results = added[-1]
                later = subprocess.run(["git", "merge-base", "--is-ancestor", commit, results]).returncode == 0
                rep.check(f"{tag}: outputs were committed after the source commit", later and results != commit,
                          f"outputs first committed in {results[:10]}")
            else:
                rep.skip(f"{tag}: outputs not committed yet")
        except subprocess.CalledProcessError:
            rep.check(f"{tag}: recorded commit exists in this repository", False, commit)
    else:
        rep.skip(f"{tag}: commit checks", "no git repository")
    return commit


def check_runs_together(commits: dict, rep: Report) -> None:
    if len(commits) < 2:
        return
    rep.check("runs: all capsules share one source commit", len(set(commits.values())) == 1,
              ", ".join(sorted(set(str(c)[:10] for c in commits.values()))))
    if git_available() and len(set(commits.values())) == 1:
        commit = next(iter(commits.values()))
        head = git("rev-parse", "HEAD").decode().strip()
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", commit, "HEAD"]).returncode == 0
        rep.check("runs: source commit precedes the current commit", ancestor and commit != head)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Data-contract and capsule-integrity checks.")
    parser.add_argument("--data", default="data")
    parser.add_argument("--run", action="append", default=[], help="run id (repeatable)")
    parser.add_argument("--all-runs", action="store_true", help="check every directory under runs/")
    parser.add_argument("--runs-dir", default="runs")
    args = parser.parse_args(argv)
    rep = Report()
    check_data(Path(args.data), rep)
    if args.all_runs and Path(args.runs_dir).exists():
        args.run = sorted(p.name for p in Path(args.runs_dir).iterdir() if p.is_dir())
    commits = {}
    for run_id in args.run:
        commits[run_id] = check_run(Path(args.runs_dir) / run_id, rep, Path(args.data))
    check_runs_together(commits, rep)
    rep.print()
    failed = rep.failed()
    skipped = [r for r in rep.rows if r[1] == "SKIP"]
    print(f"{len(rep.rows) - len(failed) - len(skipped)} passed, {len(skipped)} skipped, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
