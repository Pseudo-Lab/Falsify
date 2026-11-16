"""Load the findings table of a Blue result into a list of dicts.

Parsing is shared with check_result.py, so the Korean and English tables both work.
"""
from pathlib import Path

import check_result as cr

FINDING_FIELDS = ["page", "location", "type", "severity", "quote", "why", "confidence"]


def find_result_file(run_folder):
    """blue_result.md at the top of the run folder, or results/ in older runs."""
    run_folder = Path(run_folder)
    for candidate in (run_folder / "blue_result.md", run_folder / "results" / "blue_result.md"):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"no blue_result.md in {run_folder}")


def load_blue_findings(result_file):
    header, rows, _ = cr.parse(Path(result_file).read_text(encoding="utf-8"))
    column_map = cr.column_map(header)
    findings = []
    for _, cells in rows:
        finding = {field: cr.cell(cells, column_map, field) for field in FINDING_FIELDS}
        finding["id"] = cells[0].strip() if cells else ""
        findings.append(finding)
    return findings
