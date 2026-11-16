"""Close a run: stamp end time, duration and model in meta.json.

Usage: python tools/finish_run.py <run folder> --model <model id> [--effort <level>]

For red runs, also moves keys/ (the answers and red_report.html) out of the workspace to
../falsify-keys/<paper>/<run>/, so later Blue sessions cannot read them.
"""
import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # the workspace (this file is the copy in <workspace>/tools)
KEYS_ROOT = ROOT.parent / "falsify-keys"


def count_findings(result):
    if not result.is_file():
        return None
    rows = [l for l in result.read_text(encoding="utf-8").splitlines() if l.strip().startswith("|")]
    data = [l for l in rows if not re.fullmatch(r"[\s|:-]+", l)]
    return max(len(data) - 1, 0)  # minus the header row


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run")
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort", default="")
    args = parser.parse_args()

    run = Path(args.run)
    if not run.is_absolute():
        run = ROOT / run
    meta_file = run / "meta.json"
    if not meta_file.is_file():
        sys.exit(f"ERROR: {meta_file} not found")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    if meta.get("finished_at"):
        sys.exit(f"ERROR: {meta['run_dir']} was already finished at {meta['finished_at']}")

    end = datetime.now().astimezone()
    start = datetime.fromisoformat(meta["started_at"])
    meta.update(finished_at=end.isoformat(timespec="seconds"),
                duration_minutes=round((end - start).total_seconds() / 60, 1),
                model=args.model)
    if args.effort:
        meta["reasoning_effort"] = args.effort

    if meta["mode"] == "red":
        key_file = run / "keys" / "answer_key.json"
        if not key_file.is_file():  # Markdown runs write keys/<paper-id>.json in the team's format
            key_file = next(iter(sorted((run / "keys").glob("*.json"))), key_file)
        if key_file.is_file():
            data = json.loads(key_file.read_text(encoding="utf-8"))
            meta["defects_planted"] = len(data if isinstance(data, list) else data.get("defects", []))
        dest = KEYS_ROOT / run.parent.name / run.name
        if dest.exists():
            sys.exit(f"ERROR: {dest} already exists; not moving keys")
        dest.mkdir(parents=True)
        for sub in ("keys", "results"):  # results/ only exists in runs made before the flat layout
            if (run / sub).exists():
                shutil.move(str(run / sub), str(dest / sub))
        meta["answers_moved_to"] = str(dest)
    else:
        meta["findings"] = count_findings(next((p for p in (run / "blue_result.md", run / "results" / "blue_result.md") if p.is_file()), run / "blue_result.md"))

    meta_file.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"finished {meta['run_dir']}: {meta['duration_minutes']} min, model {meta['model']}"
          + (f", {meta.get('findings')} findings" if meta["mode"] != "red" else
             f", answers moved to {meta['answers_moved_to']}"))


if __name__ == "__main__":
    main()
