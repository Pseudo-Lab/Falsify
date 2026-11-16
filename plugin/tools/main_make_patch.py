"""Red, Markdown papers: turn the edited copy into the team's deliverables and check them.

Usage: python tools/main_make_patch.py <run folder>

Reads  <run>/source/<paper-id>.md   the clean paper
       <run>/work/edited.md         the same paper with the planted change
Writes <run>/handoff/<paper-id>.diff          unified diff (what Red submits)
       <run>/handoff/<paper-id>.tampered.md   what Blue receives (team warning header on top)
       <run>/keys/patch_v1.diff               the first patch of this run, kept
       <run>/keys/patch_final.diff            the latest patch

The diff is generated, never hand-written, and is verified by applying it with the team's
own tools/apply_patch.py: the result must equal the edited copy exactly.
"""
import difflib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def load_team_patch_tool():
    try:
        import apply_patch
    except ImportError:
        sys.exit("ERROR: tools/apply_patch.py (the team's tool) is not in the workspace tools/ folder. "
                 "The plugin must sit inside the Falsify repo so start_run.py can copy it.")
    return apply_patch


def find_source(run):
    sources = sorted((run / "source").glob("*.md"))
    if len(sources) != 1:
        sys.exit(f"ERROR: expected exactly one .md in {run / 'source'}, found {len(sources)}")
    return sources[0]


def make_diff(original, edited, pid):
    lines = difflib.unified_diff(original.split("\n"), edited.split("\n"),
                                 fromfile=f"corpus/raw/{pid}.md", tofile=f"submissions/{pid}.md",
                                 n=3, lineterm="")
    return "\n".join(lines) + "\n"


def changed_lines(original, edited):
    """(1-based line numbers removed/replaced in the original, count of added lines)."""
    matcher = difflib.SequenceMatcher(None, original.split("\n"), edited.split("\n"), autojunk=False)
    removed, added = [], 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            removed += list(range(i1 + 1, i2 + 1)) or [i1 + 1]
            added += j2 - j1
    return removed, added


def write_outputs(run, pid, diff_text, tampered_text):
    handoff, keys = run / "handoff", run / "keys"
    handoff.mkdir(exist_ok=True)
    keys.mkdir(exist_ok=True)
    (handoff / f"{pid}.diff").write_text(diff_text, encoding="utf-8", newline="\n")
    (handoff / f"{pid}.tampered.md").write_text(tampered_text, encoding="utf-8", newline="\n")
    if not (keys / "patch_v1.diff").exists():
        (keys / "patch_v1.diff").write_text(diff_text, encoding="utf-8", newline="\n")
    (keys / "patch_final.diff").write_text(diff_text, encoding="utf-8", newline="\n")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    run = Path(sys.argv[1])
    team_tool = load_team_patch_tool()
    source = find_source(run)
    pid = source.stem
    original = source.read_text(encoding="utf-8")
    edited = (run / "work" / "edited.md").read_text(encoding="utf-8")
    if original == edited:
        sys.exit("ERROR: work/edited.md is identical to the source. Plant the defect in work/edited.md first.")

    diff_text = make_diff(original, edited, pid)
    applied = team_tool.apply_unified_diff(original, diff_text)
    if applied != edited:
        sys.exit("ERROR: the generated patch does not reproduce work/edited.md when applied. Nothing was written.")
    tampered = team_tool.make_header(pid, f"{pid}.diff") + applied
    write_outputs(run, pid, diff_text, tampered)

    removed, added = changed_lines(original, edited)
    print(f"wrote handoff/{pid}.diff and handoff/{pid}.tampered.md; patch verified with the team's apply_patch")
    print(f"location for the key: L{removed[0]} (changed source lines: {', '.join(map(str, removed))}; added lines: {added})")
    if len(removed) > 1 or added > 1:
        print("WARNING: more than one line changed. The team rule is one sentence only; "
              "undo the extra changes in work/edited.md and run this again unless one sentence spans these lines.")


if __name__ == "__main__":
    main()
