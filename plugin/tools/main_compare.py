"""Compare one Blue run with an answer key. HUMAN ONLY, never in a blind session.

Usage: python <plugin>/tools/main_compare.py show <blue run folder> <answer key file>
       python <plugin>/tools/main_compare.py save <blue run folder>

The comparison itself is written by the session (see skills/compare/SKILL.md): answer keys
come in many shapes (a Red report in Markdown, the team's JSON, a CSV), so there is no
fixed parser. This script only moves text in and the result out:

  show  prints the answer key, the Blue result and the run's metadata, so the session can
        read them without opening files outside the workspace itself.
  save  moves the finished draft (<run>/work/compare_draft.md) out of the workspace to
        <workspace>/../falsify-keys/<paper>/<run>/compare.md, because it contains the answers.

Run it from the workspace folder.
"""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from funct_blue_findings import find_result_file  # noqa: E402

TEXT_KEYS = {".md", ".json", ".csv", ".txt", ".tsv", ".diff"}
META_FIELDS = ["paper_file", "paper_kind", "run", "model", "reasoning_effort", "duration_minutes",
               "findings", "prompt_sha256", "isolation", "started_at"]


def keys_folder(run):
    """runs/<paper>/<run> inside the workspace -> ../falsify-keys/<paper>/<run> beside it."""
    run = run.resolve()
    return run.parents[2].parent / "falsify-keys" / run.parent.name / run.name


def read_key(path):
    if not path.is_file():
        sys.exit(f"ERROR: answer key not found: {path}")
    if path.suffix.lower() not in TEXT_KEYS:
        sys.exit(f"ERROR: {path.name} is not a text file. The key must be readable text "
                 f"({', '.join(sorted(TEXT_KEYS))}); convert a PDF or Word key first.")
    return path.read_text(encoding="utf-8-sig", errors="replace")


def read_meta(run):
    meta_file = run / "meta.json"
    meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.is_file() else {}
    return {field: meta.get(field, "") for field in META_FIELDS}


def show(run, key_path):
    result_file = find_result_file(run)
    print(f"=== RUN INFO ===\n{json.dumps(read_meta(run), ensure_ascii=False, indent=1)}")
    print(f"blue result file: {result_file}")
    print(f"answer key file: {key_path}")
    print(f"draft goes to: {(run / 'work' / 'compare_draft.md').as_posix()}")
    print(f"\n=== ANSWER KEY ===\n{read_key(key_path)}")
    print(f"\n=== BLUE RESULT ===\n{result_file.read_text(encoding='utf-8')}")


def save(run):
    draft = run / "work" / "compare_draft.md"
    if not draft.is_file():
        sys.exit(f"ERROR: {draft} not found. Write the comparison there first.")
    target = keys_folder(run) / "compare.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(draft), str(target))
    print(f"저장: {target}")
    print("정답이 들어 있는 문서라 작업 폴더 밖에 두었습니다. 채점 전에는 Blue에게 공유하지 마세요.")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "show":
        show(Path(args[1]), Path(args[2]))
    elif len(args) == 2 and args[0] == "save":
        save(Path(args[1]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
