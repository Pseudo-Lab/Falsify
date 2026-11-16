"""Export a finished Blue run as the team's CSV (the input of the repo's tools/score.py).

Usage: python <plugin>/tools/main_blue_csv.py <blue run folder> --team <team name> [--out <file.csv>]

Columns (fixed by the team):
  paper_id, team, judge_type, model, iteration, location, defect_type, label, evidence,
  time_sec, tokens, is_holdout

- location: for a Markdown paper, the line number of the quoted text in paper.md (L142),
  found by searching for the quote; for a PDF paper, the page as written (p.3).
- label: 확인필요 for 확인필요 rows, 맞음 for every other row. score.py counts 맞음 as
  "flagged as a defect" (its fixtures do too), which is what a Blue finding row is.
- iteration: the run number (blue-run2 -> 2). tokens and is_holdout are left empty.
Default output: <run>/blue_result.csv. Copy it to results/wN/<team>.csv to submit.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from funct_blue_findings import find_result_file, load_blue_findings  # noqa: E402
from funct_md_quotes import find_line, header_offset, stated_lines  # noqa: E402

COLUMNS = ["paper_id", "team", "judge_type", "model", "iteration", "location", "defect_type",
           "label", "evidence", "time_sec", "tokens", "is_holdout"]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run")
    parser.add_argument("--team", required=True)
    parser.add_argument("--out")
    return parser.parse_args()


def load_meta(run):
    meta_file = run / "meta.json"
    return json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.is_file() else {}


def location_of(finding, paper_lines):
    """(location text, True when it could be verified against the paper)."""
    if paper_lines is None:  # PDF run: keep the page
        return f"p.{finding['page'].strip()}", True
    offset = header_offset(paper_lines)
    line = find_line(finding["quote"].split(" / ")[0], paper_lines)
    if line:
        return f"L{max(line - offset, 1)}", True
    stated = stated_lines(finding["page"])
    return (f"L{max(stated[0] - offset, 1)}" if stated else ""), False


def label_of(finding):
    return "확인필요" if re.search(r"확인\s*필요|needs check", finding["type"], re.I) else "맞음"


def defect_type_of(finding):
    code = re.match(r"\s*(D[1-4])", finding["type"])
    return code.group(1) if code else finding["type"].strip()


def build_rows(findings, paper_lines, meta, team, run):
    iteration = re.search(r"(\d+)$", run.name)
    minutes = meta.get("duration_minutes")
    common = {
        "paper_id": meta.get("paper_id") or Path(meta.get("paper_file", run.parent.name)).stem,
        "team": team, "judge_type": "model", "model": meta.get("model", ""),
        "iteration": iteration.group(1) if iteration else "1",
        "time_sec": round(minutes * 60) if minutes is not None else "", "tokens": "", "is_holdout": "",
    }
    rows, unverified = [], []
    for finding in findings:
        location, verified = location_of(finding, paper_lines)
        if not verified:
            unverified.append(finding["id"])
        rows.append({**common, "location": location, "defect_type": defect_type_of(finding),
                     "label": label_of(finding), "evidence": finding["why"]})
    return rows, unverified


def write_csv(path, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    run = Path(args.run)
    findings = load_blue_findings(find_result_file(run))
    paper_md = run / "paper.md"
    paper_lines = paper_md.read_text(encoding="utf-8").split("\n") if paper_md.is_file() else None

    rows, unverified = build_rows(findings, paper_lines, load_meta(run), args.team, run)
    out = Path(args.out) if args.out else run / "blue_result.csv"
    write_csv(out, rows)
    print(f"저장: {out} ({len(rows)}행)")
    if unverified:
        print(f"경고: 인용문을 paper.md에서 찾지 못한 행: {', '.join(unverified)}. "
              "이 행의 위치는 결과표에 적힌 줄 번호를 그대로 썼습니다. 직접 확인하세요.")
    if paper_lines is None:
        print("참고: PDF 논문이라 위치를 쪽(p.N)으로 적었습니다. score.py는 줄 번호(L142)로 대조하므로 "
              "정답지의 위치 표기와 맞는지 확인하세요.")


if __name__ == "__main__":
    main()
