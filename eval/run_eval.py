"""Batch evaluation runner for Falsify Season 13 gates (D1, D2, D3) and tools/score.py."""
from __future__ import annotations

import argparse
import csv
import importlib
import json
import pathlib
import sys
import time
from collections import defaultdict
from typing import Any, Callable, Sequence

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if __package__ in (None, "") and str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from gates.cli import run_gates, write_predictions_csv
from gates.d2_citation import CitationResolver, DictCitationResolver
from gates.models import (
    DEFECT_TYPES,
    VALID_VERDICTS,
    VERDICT_DEFECT,
    GateFinding,
    aggregate_verdict,
    normalize_verdict,
)


def _load_score_module():
    tools_dir = str(REPO_ROOT / "tools")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    return importlib.import_module("score")


def _resolve_path(raw: str, base_dir: pathlib.Path) -> pathlib.Path:
    p = pathlib.Path(raw)
    return p if p.is_absolute() else (base_dir / p).resolve()


def load_cases_from_path(input_path: pathlib.Path) -> list[dict[str, Any]]:
    """Load evaluation cases from a manifest JSON file or a directory of case folders."""
    if not input_path.exists():
        raise FileNotFoundError(f"Evaluation input path does not exist: {input_path}")

    if input_path.is_file():
        data = json.loads(input_path.read_text(encoding="utf-8"))
        raw_cases = data["cases"] if isinstance(data, dict) else data
        base = input_path.parent
        cases = []
        for idx, item in enumerate(raw_cases, 1):
            cases.append({
                "case_id": str(item.get("case_id") or f"case-{idx}"),
                "paper_id": str(item.get("paper_id") or item.get("case_id") or f"paper-{idx}"),
                "document_path": _resolve_path(item["document_path"], base),
                "fact_card_path": _resolve_path(item["fact_card_path"], base),
                "defect_type": item.get("defect_type"),
                "location": item.get("location", ""),
                "is_holdout": bool(item.get("is_holdout", False)),
                "citation_index_path": _resolve_path(item["citation_index_path"], base)
                if item.get("citation_index_path")
                else None,
            })
        return cases

    cases = []
    for sub in sorted(p for p in input_path.iterdir() if p.is_dir()):
        doc = sub / "document.md"
        fc = sub / "fact_card.json"
        if doc.exists() and fc.exists():
            cit = sub / "citation_index.json"
            cases.append({
                "case_id": sub.name,
                "paper_id": sub.name,
                "document_path": doc,
                "fact_card_path": fc,
                "defect_type": None,
                "location": "",
                "is_holdout": False,
                "citation_index_path": cit if cit.exists() else None,
            })
    if not cases:
        raise ValueError(f"No evaluation cases found in {input_path}")
    return cases


def _load_answer_key_csv(path: pathlib.Path) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            r = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
            cid = r.get("case_id") or r.get("paper_id")
            if not cid:
                continue
            raw_label = r.get("label") or r.get("verdict") or ""
            out[cid] = {
                "case_id": cid,
                "defect_type": (r.get("defect_type") or "").upper(),
                "verdict": normalize_verdict(raw_label),
            }
    return out


def _compute_classification_metrics(
    predictions: list[dict[str, str]],
    answer_key: dict[str, dict[str, str]],
) -> dict[str, Any]:
    by_defect: dict[str, list[tuple[str, str]]] = defaultdict(list)
    all_pairs: list[tuple[str, str]] = []
    for pred in predictions:
        cid = pred["case_id"]
        if cid not in answer_key:
            continue
        truth = answer_key[cid]["verdict"]
        dtype = answer_key[cid]["defect_type"] or pred["defect_type"]
        pair = (truth, pred["verdict"])
        all_pairs.append(pair)
        by_defect[dtype].append(pair)

    summary = {"overall": _metrics_for_pairs(all_pairs), "by_defect": {}}
    for dtype in sorted(set(DEFECT_TYPES) | set(by_defect)):
        if by_defect[dtype]:
            summary["by_defect"][dtype] = _metrics_for_pairs(by_defect[dtype])
    return summary


def _metrics_for_pairs(pairs: list[tuple[str, str]]) -> dict[str, Any]:
    total = len(pairs)
    correct = sum(1 for t, p in pairs if t == p)
    accuracy = round(correct / total, 4) if total else 0.0

    confusion: dict[str, dict[str, int]] = {
        t: {p: 0 for p in VALID_VERDICTS} for t in VALID_VERDICTS
    }
    for t, p in pairs:
        confusion[t][p] += 1

    f1_by_label: dict[str, float] = {}
    present_labels: list[str] = []
    for lbl in VALID_VERDICTS:
        tp = confusion[lbl][lbl]
        fp = sum(confusion[t][lbl] for t in VALID_VERDICTS if t != lbl)
        fn = sum(confusion[lbl][p] for p in VALID_VERDICTS if p != lbl)
        if tp + fp + fn > 0:
            present_labels.append(lbl)
        denom = (2 * tp) + fp + fn
        f1_by_label[lbl] = round((2 * tp) / denom, 4) if denom else 0.0

    macro_f1 = (
        round(sum(f1_by_label[l] for l in present_labels) / len(present_labels), 4)
        if present_labels
        else 0.0
    )
    return {
        "total": total,
        "correct": correct,
        "accuracy": accuracy,
        "macro_f1": macro_f1,
        "f1_by_label": f1_by_label,
        "confusion_matrix": confusion,
    }


def _resolver_for_case(case: dict[str, Any], default_resolver: CitationResolver | None) -> CitationResolver | None:
    cit_path = case.get("citation_index_path")
    if cit_path is not None:
        raw = json.loads(pathlib.Path(cit_path).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return DictCitationResolver(doi_index=raw)
        if isinstance(raw, list):
            return DictCitationResolver(records=raw)
    return default_resolver


def evaluate_cases(
    cases: list[dict[str, Any]],
    output_csv: pathlib.Path,
    *,
    resolver: CitationResolver | None = None,
    llm_judge: Callable[[str, list[dict[str, Any]]], Any] | None = None,
    answer_key_csv: pathlib.Path | None = None,
    keys_dir: pathlib.Path | None = None,
    papers_csv: pathlib.Path | None = None,
    team: str = "blue-gates",
    model: str = "falsify-gates-v1",
) -> dict[str, Any]:
    """Run gates across cases, write Blue CSV, and compute summary metrics."""
    t0 = time.monotonic()
    all_findings: list[GateFinding] = []
    case_predictions: list[dict[str, str]] = []

    for case in cases:
        doc_text = pathlib.Path(case["document_path"]).read_text(encoding="utf-8")
        fact_card = json.loads(pathlib.Path(case["fact_card_path"]).read_text(encoding="utf-8"))
        gates_to_run = [case["defect_type"]] if case.get("defect_type") else list(DEFECT_TYPES)
        case_res = _resolver_for_case(case, resolver)

        findings = run_gates(
            doc_text,
            fact_card,
            gates=gates_to_run,
            paper_id=case["paper_id"],
            resolver=case_res,
            llm_judge=llm_judge,
        )
        if not findings:
            findings = [
                GateFinding(
                    case_id=case["case_id"],
                    defect_type=(gates_to_run[0] if gates_to_run else "D1"),
                    verdict="확인필요",
                    confidence=0.2,
                    reason="No verifiable claims extracted for case",
                    location=case.get("location") or "L1",
                    paper_id=case["paper_id"],
                )
            ]
        all_findings.extend(findings)
        case_predictions.append({
            "case_id": case["case_id"],
            "paper_id": case["paper_id"],
            "defect_type": (case.get("defect_type") or findings[0].defect_type).upper(),
            "verdict": aggregate_verdict(findings),
        })

    elapsed = time.monotonic() - t0
    write_predictions_csv(output_csv, all_findings, team=team, model=model, time_sec=elapsed)

    summary: dict[str, Any] = {
        "cases_evaluated": len(cases),
        "findings_emitted": len(all_findings),
        "defects_flagged": sum(1 for f in all_findings if f.verdict == VERDICT_DEFECT),
        "output_csv": str(output_csv),
        "elapsed_sec": round(elapsed, 4),
    }

    if answer_key_csv is not None:
        answer_key = _load_answer_key_csv(answer_key_csv)
        summary["classification"] = _compute_classification_metrics(case_predictions, answer_key)

    if keys_dir is not None:
        score_mod = _load_score_module()
        rows = score_mod.load_blue_rows(output_csv.parent if output_csv.is_file() else output_csv)
        rows = [r for r in rows if pathlib.Path(r["_file"]).resolve() == output_csv.resolve()]
        keys = score_mod.load_keys(keys_dir)
        papers = score_mod.load_papers(papers_csv)
        summary["score"] = score_mod.score_rows(rows, keys, papers)

    return summary


def render_markdown_summary(summary: dict[str, Any]) -> str:
    """Render evaluation summary as a GitHub-flavored Markdown report."""
    lines = [
        "# Falsify Evaluation Summary",
        "",
        f"- Cases evaluated: {summary['cases_evaluated']}",
        f"- Findings emitted: {summary['findings_emitted']}",
        f"- Defects flagged: {summary['defects_flagged']}",
        f"- Elapsed: {summary['elapsed_sec']}s",
    ]
    cls_data = summary.get("classification")
    if cls_data:
        ov = cls_data["overall"]
        lines += [
            "",
            "## Per-Defect Classification Metrics",
            "",
            "| Scope | Cases | Correct | Accuracy | Macro F1 |",
            "|---|---:|---:|---:|---:|",
            f"| Overall | {ov['total']} | {ov['correct']} | {ov['accuracy']:.4f} | {ov['macro_f1']:.4f} |",
        ]
        for dtype, m in sorted(cls_data["by_defect"].items()):
            lines.append(
                f"| {dtype} | {m['total']} | {m['correct']} | {m['accuracy']:.4f} | {m['macro_f1']:.4f} |"
            )
        cm = ov["confusion_matrix"]
        lines += [
            "",
            "## Confusion Matrix (Rows = Truth, Cols = Predicted)",
            "",
            "| Truth \\ Pred | 맞음 | 아님 | 확인필요 |",
            "|---|---:|---:|---:|",
        ]
        for t in VALID_VERDICTS:
            lines.append(f"| {t} | {cm[t]['맞음']} | {cm[t]['아님']} | {cm[t]['확인필요']} |")

    if summary.get("score"):
        score_mod = _load_score_module()
        lines += ["", score_mod.render_table(summary["score"], "eval").rstrip()]
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run Falsify gates over a case manifest/directory and score results")
    ap.add_argument("--input", required=True, help="Manifest JSON file or directory of case subdirectories")
    ap.add_argument("--output-csv", required=True, help="Destination Blue predictions CSV")
    ap.add_argument("--answer-key", default=None, help="Optional answer-key CSV (case_id,defect_type,label)")
    ap.add_argument("--keys-dir", default=None, help="Optional Red keys JSON dir for tools/score.py")
    ap.add_argument("--papers", default=None, help="Optional corpus/papers.csv for tools/score.py")
    ap.add_argument("--citation-index", default=None, help="Optional offline JSON citation index for D2")
    ap.add_argument("--summary-json", default=None, help="Optional summary JSON output path")
    ap.add_argument("--summary-md", default=None, help="Optional summary Markdown output path")
    ap.add_argument("--team", default="blue-gates", help="Team identifier")
    ap.add_argument("--model", default="falsify-gates-v1", help="Model/gate identifier")
    args = ap.parse_args(list(argv) if argv is not None else None)

    try:
        cases = load_cases_from_path(pathlib.Path(args.input))
        resolver = None
        if args.citation_index:
            raw_idx = json.loads(pathlib.Path(args.citation_index).read_text(encoding="utf-8"))
            resolver = (
                DictCitationResolver(doi_index=raw_idx)
                if isinstance(raw_idx, dict)
                else DictCitationResolver(records=raw_idx)
            )
        summary = evaluate_cases(
            cases,
            pathlib.Path(args.output_csv),
            resolver=resolver,
            answer_key_csv=pathlib.Path(args.answer_key) if args.answer_key else None,
            keys_dir=pathlib.Path(args.keys_dir) if args.keys_dir else None,
            papers_csv=pathlib.Path(args.papers) if args.papers else None,
            team=args.team,
            model=args.model,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"EVALUATION FAILED: {exc}", file=sys.stderr)
        return 1

    md = render_markdown_summary(summary)
    if args.summary_json:
        out_j = pathlib.Path(args.summary_json)
        out_j.parent.mkdir(parents=True, exist_ok=True)
        out_j.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.summary_md:
        out_m = pathlib.Path(args.summary_md)
        out_m.parent.mkdir(parents=True, exist_ok=True)
        out_m.write_text(md, encoding="utf-8")

    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
