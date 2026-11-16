"""Create (or refresh) a Falsify workspace: the folder every Blue/Red session starts in.

Usage: python <plugin>/tools/init_workspace.py [folder] [--force]
       (folder defaults to the current folder)

Creates papers/, runs/ and .claude/settings.json (copied from <plugin>/templates/settings.json).
The settings block web search and every site except the public reference/registry APIs used
to check whether a cited reference or a registered analysis is genuine (Crossref, DataCite,
PubMed, DRKS, ClinicalTrials.gov), reachable through WebFetch only.
Safe to re-run: existing papers and runs are never touched; an existing settings.json is
replaced only with --force (use it after the template changes).

Refuses a folder that is inside a git repo or has a CLAUDE.md in it or above it,
because Claude Code loads every CLAUDE.md above the folder a session starts in,
and a run must get its rules only from the prompt.
"""
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]


def parse_args():
    """Flags may arrive inside one quoted string (from the skill), so split again."""
    words = shlex.split(" ".join(sys.argv[1:]), posix=False)
    flags = {w for w in words if w.startswith("--")}
    unknown = flags - {"--force"}
    if unknown:
        sys.exit(f"ERROR: unknown option {', '.join(sorted(unknown))}\n{__doc__}")
    folders = [w.strip("\"'") for w in words if not w.startswith("--")]
    return Path(folders[0] if folders else ".").resolve(), "--force" in flags


def refuse_unsafe_location(ws):
    try:
        top = subprocess.run(["git", "-C", str(ws), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True).stdout.strip()
    except OSError:
        top = ""
    if top:
        sys.exit(f"ERROR: {ws} is inside the git repo {top}. Choose a folder outside any repo.")
    for folder in [ws, *ws.parents]:
        for name in ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"):
            if (folder / name).is_file():
                sys.exit(f"ERROR: {folder / name} would be loaded into every run. Choose another folder.")


def write_settings(ws, force):
    target = ws / ".claude" / "settings.json"
    if target.exists() and not force:
        print(f"kept existing {target} (use --force to replace it with the plugin's template)")
        return
    shutil.copyfile(PLUGIN / "templates" / "settings.json", target)
    print(f"wrote {target} (web blocked except reference and registry lookups)")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ws, force = parse_args()
    ws.mkdir(parents=True, exist_ok=True)
    refuse_unsafe_location(ws)
    for sub in ("papers", "runs", ".claude"):
        (ws / sub).mkdir(exist_ok=True)
    write_settings(ws, force)

    user_md = Path.home() / ".claude" / "CLAUDE.md"
    if user_md.is_file():
        print(f"WARNING: {user_md} loads in every session, including blind runs.")
    print(f"Workspace ready: {ws}")
    print("Next: put papers (.pdf or .md) in papers/, start `claude` in this folder, then /falsify:blue <paper>.")
    print(f"Red answers will be moved to: {ws.parent / 'falsify-keys'}")


if __name__ == "__main__":
    main()
