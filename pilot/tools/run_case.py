"""Launch one scheduled case and capture its provenance.

Usage: ``python -m tools.run_case --case <case_id>`` from the repository root.

Before the run, every check is made and the launch record is prepared without
touching ``runs/``: the committed source must be clean, the commit must not
already contain run outputs, installed packages must match
``environment.lock``. Then ``runs/<case_id>/`` is created with the source
archive (``source.tar``), its index (``source_index.json``) and the launch
record (``launch.json``). The case runs in a child process through Hydra, which
writes ``.hydra/``. Afterwards ``run_manifest.json`` records exit status and
output hashes. A run id is never reused.
"""

import argparse
import hashlib
import io
import json
import platform
import re
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

SOURCE_PATHS = ["src", "tools", "configs", "protocol", "schedule", "pyproject.toml", "environment.lock",
                ".gitattributes"]
RUNS_DIR = Path("runs")
GIT = ["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.quotepath=off"]


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def git(*args, binary=False):
    out = subprocess.run([*GIT, *args], capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode("utf-8")


def write_json(obj, path):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def load_case(schedule: Path, case_id: str) -> list:
    with open(schedule, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                rec = json.loads(line)
                if rec["case_id"] == case_id:
                    return list(rec["overrides"])
    raise SystemExit(f"case {case_id!r} not found in {schedule}")


def locked_versions(lock: Path) -> dict:
    out = {}
    for line in lock.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        match = re.match(r"^([A-Za-z0-9_.\-]+)==([^\s#]+)$", line)
        if match:
            out[match.group(1)] = match.group(2)
    return out


def environment_record(repo: Path) -> dict:
    """Installed versions compared with environment.lock (public version part), plus the torch build."""
    import torch
    from packaging.version import Version

    lock = repo / "environment.lock"
    pinned = locked_versions(lock)
    installed, mismatches = {}, []
    for name, version in sorted(pinned.items()):
        try:
            installed[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            installed[name] = None
        if installed[name] is None or Version(installed[name]).public != Version(version).public:
            mismatches.append({"package": name, "locked": version, "installed": installed[name]})
    if torch.version.cuda is not None:
        mismatches.append({"package": "torch", "locked": "CPU build", "installed": f"CUDA {torch.version.cuda}"})
    record = {
        "python_version": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "installed": installed,
        "torch_build": {"version": torch.__version__, "cuda": torch.version.cuda},
        "environment_lock_sha256": sha256_file(lock),
        "lock_mismatches": mismatches,
    }
    record["environment_sha256"] = sha256_bytes(json.dumps(record, sort_keys=True).encode())
    return record


def source_snapshot(commit: str):
    """Archive bytes and per-file hashes of the committed source; both must agree."""
    archive = git("archive", "--format=tar", commit, "--", *SOURCE_PATHS, binary=True)
    files = {}
    for entry in git("ls-tree", "-r", "-z", commit, "--", *SOURCE_PATHS).split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        files[path] = sha256_bytes(git("cat-file", "blob", meta.split()[2], binary=True))
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        in_tar = {m.name: sha256_bytes(tar.extractfile(m).read()) for m in tar.getmembers() if m.isfile()}
        comment = tar.pax_headers.get("comment")
    if in_tar != files or comment != commit:
        raise SystemExit("source archive does not match the committed tree")
    return archive, files


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run one scheduled case with provenance capture.")
    parser.add_argument("--case", required=True)
    parser.add_argument("--schedule", default="schedule/cases.jsonl")
    args = parser.parse_args(argv)

    repo = Path(git("rev-parse", "--show-toplevel").strip())
    if Path.cwd().resolve() != repo.resolve():
        raise SystemExit("run from the repository root")
    run_dir = RUNS_DIR / args.case
    if run_dir.exists():
        raise SystemExit(f"{run_dir} already exists; run ids are not reused")
    overrides = load_case(Path(args.schedule), args.case)

    commit = git("rev-parse", "HEAD").strip()
    dirty = [line for line in git("status", "--porcelain", "--untracked-files=all", "--",
                                  *SOURCE_PATHS, "data").splitlines() if line.strip()]
    if dirty:
        raise SystemExit(f"source or data paths have uncommitted changes: {dirty[:5]}")
    if git("ls-tree", "-d", commit, "--", "runs").strip():
        raise SystemExit("the source commit already contains run outputs; run from the frozen source commit")
    env = environment_record(repo)
    if env["lock_mismatches"]:
        raise SystemExit(f"installed packages differ from environment.lock: {env['lock_mismatches']}")
    archive, files = source_snapshot(commit)
    data_tree = git("rev-parse", f"{commit}:data").strip()

    child = ["python", "-m", "src.pipeline", f"run_id={args.case}", f"hydra.run.dir={run_dir.as_posix()}",
             *overrides]
    launch = {
        "captured_by": "tools/run_case.py",
        "captured_at": now(),
        "command": ["python", "-m", "tools.run_case", *(argv if argv is not None else sys.argv[1:])],
        "cwd": str(Path.cwd()),
        "case_id": args.case,
        "schedule": args.schedule,
        "schedule_sha256": sha256_file(args.schedule),
        "overrides": overrides,
        "child_command": child,
        "source_commit": commit,
        "source_dirty": False,
        "data_tree": data_tree,
        "python_version": env["python_version"],
        "environment_sha256": env["environment_sha256"],
    }

    run_dir.mkdir(parents=True)
    (run_dir / "source.tar").write_bytes(archive)
    write_json({
        "source_commit": commit,
        "source_dirty": False,
        "source_paths": SOURCE_PATHS,
        "archive": "source.tar",
        "archive_sha256": sha256_bytes(archive),
        "files": files,
        "data_tree": data_tree,
        "environment": env,
    }, run_dir / "source_index.json")
    write_json(launch, run_dir / "launch.json")

    started = now()
    with open(run_dir / "console.log", "wb") as log:
        proc = subprocess.run([sys.executable, *child[1:]], stdout=log, stderr=subprocess.STDOUT)
    ended = now()

    inputs_path = run_dir / "inputs.json"
    inputs = json.loads(inputs_path.read_text(encoding="utf-8")) if inputs_path.exists() else {}
    outputs = {}
    for path in sorted(p for p in run_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(run_dir).as_posix()
        if rel != "run_manifest.json":
            outputs[rel] = sha256_file(path)
    selected_params = None
    index = run_dir / "checkpoint_index.jsonl"
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            rec = json.loads(line)
            if rec.get("selected"):
                selected_params = rec["params_sha256"]
    write_json({
        "run_id": args.case,
        "case_id": args.case,
        "source_commit": commit,
        "started_at": started,
        "ended_at": ended,
        "exit_code": proc.returncode,
        "seed": inputs.get("seed"),
        "overrides": overrides,
        "config_system": {"name": "hydra", "version": metadata.version("hydra-core")},
        "effective_config_sha256": inputs.get("effective_config_sha256"),
        "hydra_config_file_sha256": outputs.get(".hydra/config.yaml"),
        "data_sha256": inputs.get("data", {}).get("combined_sha256"),
        "split_id": inputs.get("split_id"),
        "split_members_sha256": inputs.get("split_members_sha256"),
        "predictions_sha256": outputs.get("predictions.csv"),
        "metrics_sha256": outputs.get("metrics.json"),
        "checkpoint_sha256": outputs.get("checkpoint.npz"),
        "checkpoint_params_sha256": selected_params,
        "environment_sha256": env["environment_sha256"],
        "outputs": outputs,
    }, run_dir / "run_manifest.json")
    print(f"{args.case}: exit {proc.returncode}")
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
