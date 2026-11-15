"""CLI runner for Falsify Season 13 verification gates (D1, D2, D3)."""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import sys
import time
from typing import Any, Callable, Sequence

if __package__ in (None, ""):
    _ROOT = str(pathlib.Path(__file__).resolve().parents[1])
    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)

from gates.d1_numeric import verify_d1_document
from gates.d2_citation import CitationResolver, DictCitationResolver, LiveCitationResolver, verify_d2_citations
from gates.d3_claim_anchor import verify_d3_document
from gates.models import DEFECT_TYPES, SCORE_COLUMNS, GateFinding


def _load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _build_resolver(
    citation_index_path: pathlib.Path | None,
    online: bool,
) -> CitationResolver | None:
    if citation_index_path is not None:
        raw = _load_json(citation_index_path)
        if isinstance(raw, dict):
            return DictCitationResolver(doi_index=raw)
        if isinstance(raw, list):
            doi_idx = {str(r.get("doi")): r for r in raw if isinstance(r, dict) and r.get("doi")}
            return DictCitationResolver(doi_index=doi_idx, records=raw)
        raise ValueError(f"Unsupported citation index format in {citation_index_path}")
    if online:
        return LiveCitationResolver()
    return None


def run_gates(
    document_text: str,
    fact_card: dict[str, Any] | None,
    *,
    gates: Sequence[str] = DEFECT_TYPES,
    paper_id: str = "",
    resolver: CitationResolver | None = None,
    llm_judge: Callable[[str, list[dict[str, Any]]], Any] | None = None,
) -> list[GateFinding]:
    """Execute selected verification gates against a document and Fact Card."""
    selected = {g.strip().upper() for g in gates}
    pid = paper_id or str((fact_card or {}).get("paper_id") or "unknown")
    findings: list[GateFinding] = []
    if "D1" in selected:
        findings.extend(verify_d1_document(document_text, fact_card, paper_id=pid))
    if "D2" in selected:
        findings.extend(verify_d2_citations(document_text, resolver=resolver, paper_id=pid))
    if "D3" in selected:
        findings.extend(verify_d3_document(document_text, fact_card, paper_id=pid, llm_judge=llm_judge))
    return findings


def write_predictions_csv(
    path: pathlib.Path,
    findings: Sequence[GateFinding],
    *,
    team: str = "blue-gates",
    judge_type: str = "rule",
    model: str = "falsify-gates-v1",
    iteration: int = 1,
    time_sec: float = 0.0,
    tokens: int = 0,
    is_holdout: bool = False,
) -> None:
    """Write GateFindings to a CSV file directly compatible with ``tools/score.py``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(SCORE_COLUMNS))
        writer.writeheader()
        for f in findings:
            writer.writerow(
                f.to_score_row(
                    team=team,
                    judge_type=judge_type,
                    model=model,
                    iteration=iteration,
                    time_sec=time_sec,
                    tokens=tokens,
                    is_holdout=is_holdout,
                )
            )


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run Falsify Season 13 verification gates (D1/D2/D3)")
    ap.add_argument("--fact-card", required=True, help="Path to Fact Card JSON")
    ap.add_argument("--document", required=True, help="Path to target Markdown/text document")
    ap.add_argument("--output", required=True, help="Output CSV path (compatible with tools/score.py)")
    ap.add_argument("--json-out", default=None, help="Optional JSON report output path")
    ap.add_argument("--gates", default="D1,D2,D3", help="Comma-separated gates to run (default: D1,D2,D3)")
    ap.add_argument("--paper-id", default="", help="Override paper_id")
    ap.add_argument("--team", default="blue-gates", help="Team name for score.py CSV")
    ap.add_argument("--model", default="falsify-gates-v1", help="Detector/model identifier")
    ap.add_argument("--iteration", type=int, default=1, help="Evaluation iteration number")
    ap.add_argument("--holdout", action="store_true", help="Mark rows as holdout in CSV")
    ap.add_argument("--citation-index", default=None, help="Optional offline JSON citation index for D2")
    ap.add_argument("--online", action="store_true", help="Enable live Crossref/EuropePMC lookup for D2")
    args = ap.parse_args(list(argv) if argv is not None else None)

    fc_path = pathlib.Path(args.fact_card)
    doc_path = pathlib.Path(args.document)
    if not fc_path.exists() or not doc_path.exists():
        print(f"Error: missing input file ({fc_path} or {doc_path})", file=sys.stderr)
        return 2

    try:
        fact_card = _load_json(fc_path)
        doc_text = doc_path.read_text(encoding="utf-8")
        resolver = _build_resolver(pathlib.Path(args.citation_index) if args.citation_index else None, args.online)
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        print(f"Error loading inputs: {exc}", file=sys.stderr)
        return 2

    t0 = time.monotonic()
    gate_list = [g.strip() for g in args.gates.split(",") if g.strip()]
    findings = run_gates(doc_text, fact_card, gates=gate_list, paper_id=args.paper_id, resolver=resolver)
    elapsed = time.monotonic() - t0

    out_csv = pathlib.Path(args.output)
    write_predictions_csv(
        out_csv,
        findings,
        team=args.team,
        model=args.model,
        iteration=args.iteration,
        time_sec=elapsed,
        is_holdout=args.holdout,
    )

    if args.json_out:
        json_path = pathlib.Path(args.json_out)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "paper_id": args.paper_id or fact_card.get("paper_id", ""),
            "gates": gate_list,
            "elapsed_sec": round(elapsed, 4),
            "counts": {
                "total": len(findings),
                "defects": sum(1 for f in findings if f.is_defect),
                "valid": sum(1 for f in findings if f.verdict == "맞음"),
                "needs_review": sum(1 for f in findings if f.verdict == "확인필요"),
            },
            "findings": [f.to_dict() for f in findings],
        }
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    defects = sum(1 for f in findings if f.is_defect)
    print(f"Wrote {len(findings)} findings ({defects} defects flagged) to {out_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
