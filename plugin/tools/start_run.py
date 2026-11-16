"""Create a numbered run folder for one paper, record its metadata, and print the prompt.

Usage: python <plugin>/tools/start_run.py <mode> <paper name or part of it> [D1|D2|D3|D4]
  mode: blue | red
Run it from the workspace folder (the one that holds papers/ and runs/).

papers/ may hold PDFs and Markdown papers (from the repo's tools/fetch_paper.py, or a
tampered copy from tools/apply_patch.py). The paper's type picks the flow:
  blue + pdf   our Blue prompt on the PDF
  blue + md    the same prompt, with a note that the paper is Markdown (locations are line numbers)
  red  + pdf   the PDF Red pipeline (prompts/red.md)
  red  + md    the team's Red prompt (docs/prompts/red_제출.md): one defect of the given type,
               delivered as a diff plus a key JSON. The defect type is required.

The prompt is assembled from the prompt files at this moment, so an edit takes effect on
the very next run. meta.json records the exact prompt text and a hash per source file.
The workspace's tools/ folder is refreshed on every start.
"""
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parent
ROOT = Path.cwd()  # the workspace

MODES = ("blue", "red")
TEAM_RED_PROMPT = REPO / "docs" / "prompts" / "red_제출.md"
# Scripts a session runs by relative path (see templates/settings.json).
SESSION_TOOLS = ["extract_pages.py", "render_pages.py", "mw_pvalues.py", "report_common.py",
                 "red_report.py", "finish_run.py", "main_make_patch.py"]
# The team's own tools that main_make_patch.py imports.
TEAM_TOOLS = ["apply_patch.py", "_common.py"]


def short_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def slug(stem):
    s = re.sub(r'[\\/:*?"<>|\[\]]', "", stem)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:60] or "paper"


def find_paper(query):
    folder = ROOT / "papers"
    papers = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".pdf", ".md"))
    q = query.strip().strip("\"'").lower()
    exact = [p for p in papers if p.name.lower() == q or p.stem.lower() == q]
    hits = exact or [p for p in papers if q and q in p.name.lower()]
    if len(hits) == 1:
        return hits[0]
    names = "\n  ".join(p.name for p in papers) or "(none)"
    reason = "no paper matches" if not hits else f"{len(hits)} papers match"
    sys.exit(f"ERROR: {reason} '{query}'. Papers in papers/:\n  {names}")


def paper_kind(paper):
    return "md" if paper.suffix.lower() == ".md" else "pdf"


def paper_id(paper):
    """PMC12215570.tampered.md -> PMC12215570"""
    return re.sub(r"\.tampered$", "", paper.stem)


def isolation_mode():
    """lookups = only the reference/registry APIs (the standard); locked = an older workspace
    with no web at all; none = no settings file."""
    settings = ROOT / ".claude" / "settings.json"
    if not settings.is_file():
        return "none"
    deny = json.loads(settings.read_text(encoding="utf-8")).get("permissions", {}).get("deny", [])
    return "locked" if "WebFetch" in deny else "lookups"


def read_prompt_file(path):
    if not path.is_file():
        sys.exit(f"ERROR: {path} is missing. Plugin prompt files are not in git "
                 "(see prompts/README.md); the team's prompts live in the repo's docs/prompts/.")
    return path.read_text(encoding="utf-8").strip()


def team_red_block(defect_type, pid):
    """The copy-paste block of the team's Red prompt, with its two placeholders filled."""
    text = read_prompt_file(TEAM_RED_PROMPT)
    block = re.search(r"```\n(.*?)\n```", text, flags=re.S)
    if not block:
        sys.exit(f"ERROR: no ``` block found in {TEAM_RED_PROMPT}")
    body = block.group(1)
    for placeholder in ("[유형]", "(여기에 논문 마크다운)"):
        if placeholder not in body:
            sys.exit(f"ERROR: {TEAM_RED_PROMPT} no longer contains {placeholder!r}; update start_run.py")
    body = body.replace("[유형]", defect_type, 1)
    return body.replace("(여기에 논문 마크다운)", f"(`RUN/source/{pid}.md` 파일을 읽으세요)")


def prompt_part_names(mode, kind, isolation):
    if mode == "red":
        return ["red_md.md"] if kind == "md" else ["red.md"]
    names = ["blue_task.md", "blue_rules.md"]
    if kind == "md":
        names.insert(0, "blue_md_note.md")
    return names


def build_prompt(mode, kind, isolation, defect_type, pid):
    parts, hashes = [], {}
    for name in prompt_part_names(mode, kind, isolation):
        text = read_prompt_file(PLUGIN / "prompts" / name)
        hashes[name] = short_hash(text)
        if name == "red_md.md":
            team = team_red_block(defect_type, pid)
            hashes["docs/prompts/red_제출.md"] = short_hash(team)
            text = (text.replace("{TEAM_PROMPT}", team).replace("{DEFECT_TYPE}", defect_type)
                    .replace("{PAPER_ID}", pid))
        parts.append(text)
    return "\n\n".join(parts) + "\n", hashes


def copy_if_changed(src, dst):
    if not dst.is_file() or dst.read_bytes() != src.read_bytes():
        shutil.copyfile(src, dst)


def sync_tools():
    dest = ROOT / "tools"
    dest.mkdir(exist_ok=True)
    for name in SESSION_TOOLS:
        copy_if_changed(PLUGIN / "tools" / name, dest / name)
    for name in TEAM_TOOLS:
        if (REPO / "tools" / name).is_file():
            copy_if_changed(REPO / "tools" / name, dest / name)


def plugin_version():
    try:
        return json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version", "")
    except (OSError, ValueError):
        return ""


def parse_args():
    """Returns (mode, paper query, defect type or '')."""
    if len(sys.argv) < 3 or sys.argv[1] not in MODES:
        sys.exit(__doc__)
    words = " ".join(sys.argv[2:]).split()
    defect_type = ""
    if len(words) > 1 and re.fullmatch(r"[Dd][1-4]", words[-1]):
        defect_type = words.pop().upper()
    return sys.argv[1], " ".join(words), defect_type


def require_workspace():
    if not (ROOT / "papers").is_dir():
        sys.exit(f"ERROR: {ROOT} has no papers/ folder. Start the session in a Falsify "
                 "workspace, or create one with /falsify:setup.")


def require_defect_type(mode, kind, defect_type):
    if mode == "red" and kind == "md" and not defect_type:
        sys.exit("ERROR: Red on a Markdown paper needs the defect type: /falsify:red <paper> D1 "
                 "(D1 number mismatch, D2 nonexistent citation, D3 overclaim, D4 misstated status).")


def next_run_folder(mode, paper):
    """runs/<paper>/<mode>-run<N> with the next free N (created empty)."""
    paper_dir = ROOT / "runs" / slug(paper_id(paper))
    paper_dir.mkdir(parents=True, exist_ok=True)
    taken = [int(m.group(1)) for d in paper_dir.iterdir()
             if (m := re.fullmatch(rf"{re.escape(mode)}-run(\d+)", d.name))]
    run = paper_dir / f"{mode}-run{max(taken, default=0) + 1}"
    run.mkdir()
    return run


def fill_red_folder(run, paper, kind):
    for sub in ("source", "work", "keys", "handoff"):
        (run / sub).mkdir()
    if kind == "pdf":
        shutil.copy2(paper, run / "source" / "paper.pdf")
        return
    pid = paper_id(paper)
    shutil.copy2(paper, run / "source" / f"{pid}.md")
    shutil.copy2(paper, run / "work" / "edited.md")  # Red edits this copy
    meta_json = paper.with_name(f"{pid}.meta.json")
    if meta_json.is_file():
        shutil.copy2(meta_json, run / "source" / meta_json.name)


def fill_blue_folder(run, paper, kind):
    (run / "work").mkdir()
    shutil.copy2(paper, run / f"paper.{kind}")


def build_meta(run, mode, paper, kind, isolation, defect_type, prompt, part_hashes):
    return {
        "run": run.name,
        "mode": mode,
        "paper_file": paper.name,
        "paper_id": paper_id(paper),
        "paper_kind": kind,
        "paper_sha256": hashlib.sha256(paper.read_bytes()).hexdigest(),
        "defect_type": defect_type,
        "isolation": isolation,
        "run_dir": str(run.relative_to(ROOT)).replace("\\", "/"),
        "started_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "finished_at": None,
        "duration_minutes": None,
        "model": "",
        "reasoning_effort": "",
        "plugin_version": plugin_version(),
        "prompt_command": f"/falsify:{mode}",
        "prompt_sha256": short_hash(prompt),
        "prompt_parts": part_hashes,
        "prompt_text": prompt,
        "notes": "",
    }


def write_meta(run, meta):
    (run / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def print_start(meta, prompt):
    print(f"RUN FOLDER: {meta['run_dir']}")
    print(f"paper: {meta['paper_file']} (sha256 {meta['paper_sha256'][:16]}), prompt {meta['prompt_sha256']}")
    print("=== PROMPT ===")
    print(prompt)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    mode, query, defect_type = parse_args()
    require_workspace()
    paper = find_paper(query)
    kind, isolation = paper_kind(paper), isolation_mode()
    require_defect_type(mode, kind, defect_type)
    prompt, part_hashes = build_prompt(mode, kind, isolation, defect_type, paper_id(paper))
    sync_tools()
    run = next_run_folder(mode, paper)
    if mode == "red":
        fill_red_folder(run, paper, kind)
    else:
        fill_blue_folder(run, paper, kind)
    meta = build_meta(run, mode, paper, kind, isolation, defect_type, prompt, part_hashes)
    write_meta(run, meta)
    print_start(meta, prompt)


if __name__ == "__main__":
    main()
