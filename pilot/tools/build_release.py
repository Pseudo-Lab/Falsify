"""Build or verify file inventories; this does not approve scientific claims."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess

EXCLUDED = {"release/manifest.json", "release/checksums.sha256"}
def safe_path(root, name):
    name_path = Path(name)
    if name_path.is_absolute() or ".." in name_path.parts or ".git" in name_path.parts: raise ValueError("unsafe artifact path")
    path = root / name_path
    if path.is_symlink() or root.resolve() not in path.resolve().parents: raise ValueError("artifact escapes repository")
    return path
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def build(root, paths):
    paths = sorted(set(paths) - EXCLUDED)
    artifact_records = [{"path": name, "sha256": digest(safe_path(root, name)), "bytes": safe_path(root, name).stat().st_size}
                        for name in paths if name != "evidence/artifact_manifest.json"]
    evidence = root / "evidence/artifact_manifest.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps({"schema_version": "dropfusion.artifacts/1.0", "artifacts": artifact_records}, indent=2) + "\n", encoding="utf-8", newline="")
    paths = sorted(set(paths) | {"evidence/artifact_manifest.json"})
    records = []
    for name in paths:
        path = safe_path(root, name)
        if path.is_symlink() or not path.is_file(): raise ValueError(f"not a regular artifact: {name}")
        records.append({"path": name, "sha256": digest(path), "bytes": path.stat().st_size})
    manifest = {"schema_version": "dropfusion.release/1.0", "release_id": "dropfusion-edu-pilot-1", "educational_fiction": True,
                "execution_mode": "staged", "release_commit_reference": None,
                "note": "Byte inventory only; scientific and independent release review are separate.", "artifacts": records}
    release = root / "release"
    release.mkdir(parents=True, exist_ok=True)
    (release / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="")
    listed = paths + ["release/manifest.json"]
    (release / "checksums.sha256").write_text("".join(f"{digest(safe_path(root, name))}  {name}\n" for name in sorted(listed)), encoding="utf-8", newline="")
    return verify(root)
def verify(root):
    manifest = json.loads((root / "release/manifest.json").read_text(encoding="utf-8"))
    for record in manifest["artifacts"]:
        path = safe_path(root, record["path"])
        if digest(path) != record["sha256"] or path.stat().st_size != record["bytes"]: raise ValueError(record["path"])
    lines = (root / "release/checksums.sha256").read_text(encoding="utf-8").splitlines()
    paths = []
    for line in lines:
        expected, name = line.split("  ", 1)
        if digest(safe_path(root, name)) != expected: raise ValueError(name)
        paths.append(name)
    if set(paths) != {record["path"] for record in manifest["artifacts"]} | {"release/manifest.json"}: raise ValueError("checksum inventory mismatch")
    if len(paths) != len(set(paths)): raise ValueError("duplicate checksum path")
    return len(manifest["artifacts"])
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.build:
        tracked = subprocess.check_output(["git", "-c", "core.quotepath=false", "ls-files", "-z"], cwd=root).decode("utf-8").split("\0")
        count = build(root, [name for name in tracked if name])
    else:
        count = verify(root)
    print(f"Verified {count} listed artifacts and the manifest checksum.")
if __name__ == "__main__": main()
