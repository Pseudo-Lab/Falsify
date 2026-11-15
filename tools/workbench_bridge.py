#!/usr/bin/env python3
"""Bridge between Shinick-Han/falsify-workbench exports and Pseudo-Lab/Falsify Season 13 tools.

Supports three subcommands and importable library functions:
  - ``red-to-submission``: Convert Workbench RED exports into validated Red submission
    JSONs, zero-leakage blind Blue target artifacts, and organizer answer-key sidecars.
  - ``blue-to-predictions``: Convert Workbench BLUE findings JSONs into
    ``tools/score.py``-compatible ``predictions.csv`` files.
  - ``roundtrip-check``: Validate end-to-end compatibility with
    ``submissions/validate_submission.py`` and ``tools/score.py``.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import json
import os
import pathlib
import re
import sys
import tempfile
from dataclasses import dataclass
from typing import Any, Sequence

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
for _p in (str(REPO_ROOT), str(TOOLS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from _common import atomic_write_text, read_json, write_json  # noqa: E402
from gates.models import (  # noqa: E402
    DEFECT_TYPES,
    SCORE_COLUMNS,
    VERDICT_DEFECT,
    VERDICT_NEEDS_REVIEW,
    VERDICT_VALID,
    GateFinding,
    normalize_verdict,
)
from submissions.validate_submission import (  # noqa: E402
    SubmissionValidationError,
    check_no_answer_key_leakage,
    validate_blue_csv,
    validate_path,
)
import apply_patch  # noqa: E402
import score  # noqa: E402

PREDICTION_COLUMNS: tuple[str, ...] = (
    "case_id",
    *SCORE_COLUMNS,
    "verdict",
    "confidence",
    "evidence_quote",
)

ANSWER_KEY_COLUMNS: tuple[str, ...] = (
    "case_id",
    "paper_id",
    "team",
    "defect_type",
    "label",
    "location",
    "page_index",
    "before",
    "after",
    "rationale",
    "patch",
)

DEFECT_TOKEN_MAP: dict[str, str] = {
    "d1": "D1",
    "numeric": "D1",
    "numeric-mismatch": "D1",
    "numeric_mismatch": "D1",
    "number": "D1",
    "table": "D1",
    "table-cell": "D1",
    "table_cell": "D1",
    "chart": "D1",
    "chart-point": "D1",
    "chart_point": "D1",
    "metric": "D1",
    "d2": "D2",
    "citation": "D2",
    "fabricated-citation": "D2",
    "fabricated_citation": "D2",
    "missing-citation": "D2",
    "reference": "D2",
    "ref": "D2",
    "doi": "D2",
    "d3": "D3",
    "claim": "D3",
    "claim-anchor": "D3",
    "claim_anchor": "D3",
    "conclusion": "D3",
    "overclaim": "D3",
    "spin": "D3",
    "causal": "D3",
    "subgroup": "D3",
}

UNCERTAIN_STATUSES: frozenset[str] = frozenset({
    "uncertain",
    "needs-verification",
    "needs_verification",
    "needs-review",
    "needs_review",
    "review",
    "unsure",
    "unknown",
    "ambiguous",
    "unverified",
    "pending",
    "indeterminate",
    "확인필요",
    "확인 필요",
    "?",
})

DEFECT_STATUSES: frozenset[str] = frozenset({
    "discrepant",
    "defect",
    "defect-detected",
    "defect_detected",
    "fail",
    "failed",
    "mismatch",
    "fabricated",
    "unsupported",
    "invalid",
    "incorrect",
    "inconsistent",
    "error",
    "flagged",
    "violation",
    "rejected",
    "아님",
    "결함",
    "no",
    "false",
})

CLEAN_STATUSES: frozenset[str] = frozenset({
    "clean",
    "no-defect",
    "no_defect",
    "no-defect-verified",
    "verified",
    "valid",
    "correct",
    "consistent",
    "pass",
    "passed",
    "ok",
    "supported",
    "normal",
    "맞음",
    "정상",
    "yes",
    "true",
})

DEFECT_SEVERITIES: frozenset[str] = frozenset({
    "critical",
    "major",
    "error",
    "discrepant",
    "high",
    "severe",
    "blocker",
})

CLEAN_SEVERITIES: frozenset[str] = frozenset({"none", "clean", "ok", "info", "pass"})

EXTRA_BLIND_LEAKAGE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r'"rationale"\s*:', flags=re.I),
    re.compile(r'"attackTypes"\s*:', flags=re.I),
    re.compile(r'"pageIndex"\s*:', flags=re.I),
    re.compile(r'\bRED_METADATA\b', flags=re.I),
)

CITATION_CLUE_RE = re.compile(r"\b(doi|citation|reference|bibliography|pmid|journal)\b|참고문헌|인용", flags=re.I)
CLAIM_CLUE_RE = re.compile(
    r"\b(conclusion|discussion|claim|significant|causal|caused|efficacy|improved|subgroup)\b|결론|고찰|유의",
    flags=re.I,
)
NUMERIC_TOKEN_RE = re.compile(r"[-+]?\d+(?:\.\d+)?%?")
HUNK_HEADER_RE = re.compile(r"^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@", flags=re.M)


class BridgeError(ValueError):
    """Raised when Workbench input payloads fail parsing or validation."""


@dataclass(frozen=True)
class RedAttackRecord:
    """Normalized representation of a Workbench RED attack item."""

    case_id: str
    paper_id: str
    team: str
    defect_type: str
    location: str
    page_index: int | None
    before: str
    after: str
    patch: str
    target_quote: str
    intended_label: str
    rationale: str
    how_to_catch: str
    detector_spec: str


@dataclass(frozen=True)
class BlueFindingRecord:
    """Normalized representation of a Workbench BLUE finding item."""

    case_id: str
    paper_id: str
    team: str
    judge_type: str
    model: str
    iteration: int
    location: str
    defect_type: str
    verdict: str
    confidence: float
    evidence_quote: str
    evidence: str
    time_sec: float
    tokens: int
    is_holdout: bool


def _first_non_empty(mapping: dict[str, Any], keys: Sequence[str], default: Any = None) -> Any:
    for key in keys:
        val = mapping.get(key)
        if val is None:
            continue
        if isinstance(val, str) and not val.strip():
            continue
        return val
    return default


def _stringify_fragment(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        inner = _first_non_empty(val, ("text", "quote", "value", "label", "content", "y"))
        if inner is not None:
            return str(inner)
        return json.dumps(val, ensure_ascii=False, sort_keys=True)
    return str(val)


def _load_payload_with_fallback(
    input_source: pathlib.Path | dict[str, Any] | list[Any],
    paper_id: str | None,
) -> tuple[Any, str]:
    if isinstance(input_source, (dict, list)):
        return input_source, paper_id or "workbench-paper"
    src = pathlib.Path(input_source)
    return read_json(src), paper_id or src.stem


def _clean_single_line(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _coerce_int(val: Any) -> int | None:
    if val is None or isinstance(val, bool):
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _coerce_float(val: Any, default: float = 0.0) -> float:
    if val is None or isinstance(val, bool):
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _coerce_bool(val: Any, default: bool = False) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        low = val.strip().lower()
        if low in {"true", "1", "yes", "y", "예", "holdout", "홀드아웃"}:
            return True
        if low in {"false", "0", "no", "n", ""}:
            return False
    return default


def _map_defect_token(token: str) -> str | None:
    norm = (token or "").strip().lower()
    if not norm:
        return None
    if norm in DEFECT_TOKEN_MAP:
        return DEFECT_TOKEN_MAP[norm]
    m = re.match(r"^(d[123])\b", norm)
    return m.group(1).upper() if m else None


def _infer_change_defect_type(item: dict[str, Any]) -> str:
    text = " ".join([
        _stringify_fragment(_first_non_empty(item, ("section", "target", "rationale", "reason"), "")),
        _stringify_fragment(_first_non_empty(item, ("before", "original", "oldText"), "")),
        _stringify_fragment(_first_non_empty(item, ("after", "tampered", "newText"), "")),
    ])
    if CITATION_CLUE_RE.search(text):
        return "D2"
    before = _stringify_fragment(_first_non_empty(item, ("before", "original", "oldText"), ""))
    after = _stringify_fragment(_first_non_empty(item, ("after", "tampered", "newText"), ""))
    if before and after and NUMERIC_TOKEN_RE.findall(before) != NUMERIC_TOKEN_RE.findall(after):
        return "D1"
    if CLAIM_CLUE_RE.search(text):
        return "D3"
    return "D1"


def infer_defect_type(
    item: dict[str, Any],
    *,
    default_attack_types: Sequence[str] = (),
    override: str | None = None,
) -> str:
    """Map Workbench ``attackTypes`` / ``kind`` / ``defect_type`` to D1/D2/D3 or custom."""
    if override and override.strip():
        return override.strip().upper()

    explicit = _first_non_empty(item, ("defect_type", "defectType", "gate"))
    if explicit:
        mapped = _map_defect_token(str(explicit))
        return mapped or str(explicit).strip().upper()

    raw_types = _first_non_empty(item, ("attackTypes", "attackType", "categories"), default_attack_types)
    candidates = [raw_types] if isinstance(raw_types, str) else list(raw_types or [])
    for tok in candidates:
        mapped = _map_defect_token(str(tok))
        if mapped:
            return mapped

    kind = str(_first_non_empty(item, ("kind", "editKind", "type"), "")).strip().lower()
    if kind in {"table-cell", "table_cell", "chart-point", "chart_point"}:
        return "D1"
    if kind == "change":
        return _infer_change_defect_type(item)
    return "D1"


def build_unified_diff(before: str, after: str, paper_id: str) -> str:
    """Create a unified diff patch from ``before`` and ``after`` fragments."""
    b_lines = before.splitlines() if before else []
    a_lines = after.splitlines() if after else []
    if b_lines == a_lines and (before or after):
        a_lines = [f"{after} [edited]"] if after else ["[edited]"]
    diff_lines = list(
        difflib.unified_diff(
            b_lines,
            a_lines,
            fromfile=f"a/{paper_id}.md",
            tofile=f"b/{paper_id}.md",
            lineterm="",
        )
    )
    if not diff_lines:
        return f"--- a/{paper_id}.md\n+++ b/{paper_id}.md\n@@ -1,1 +1,1 @@\n-{before}\n+{after}\n"
    return "\n".join(diff_lines) + "\n"


def _extract_before_after_from_diff(diff_text: str) -> tuple[str, str]:
    before_lines: list[str] = []
    after_lines: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith(("--- ", "+++ ", "@@ ")):
            continue
        if line.startswith("-"):
            before_lines.append(line[1:])
        elif line.startswith("+"):
            after_lines.append(line[1:])
    return "\n".join(before_lines), "\n".join(after_lines)


def format_location(item: dict[str, Any], fallback_id: str) -> str:
    """Format a deterministic location string compatible with ``tools/score.py``."""
    raw_loc = _first_non_empty(item, ("location", "loc"))
    if raw_loc is not None:
        if isinstance(raw_loc, int) and not isinstance(raw_loc, bool):
            return f"L{raw_loc}"
        s = str(raw_loc).strip()
        return f"L{s}" if s.isdigit() else s

    line = _coerce_int(_first_non_empty(item, ("line", "lineNumber", "line_number")))
    if line is not None:
        return f"L{line}"

    page = _coerce_int(_first_non_empty(item, ("pageIndex", "page_index", "page")))
    kind = str(_first_non_empty(item, ("kind", "editKind"), "")).strip().lower()
    if page is not None:
        return f"page:{page}:{kind}" if kind else f"page:{page}"

    section = _first_non_empty(item, ("section", "anchorId", "anchor_id"))
    if section:
        return str(section).strip()
    return fallback_id


def _extract_paper_id(payload: dict[str, Any], fallback: str) -> str:
    direct = _first_non_empty(payload, ("paperId", "paper_id", "documentId", "docId"))
    if direct:
        return str(direct).strip()
    for nested_key in ("paper", "document", "metadata"):
        nested = payload.get(nested_key)
        if isinstance(nested, dict):
            pid = _first_non_empty(nested, ("paperId", "paper_id", "pmcid", "id"))
            if pid:
                return str(pid).strip()
    return fallback


def _extract_red_items(payload: Any, fallback_paper_id: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Extract RED items and top-level defaults from supported Workbench JSON exports."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)], {"paper_id": fallback_paper_id, "team": "red-workbench"}
    if not isinstance(payload, dict):
        raise BridgeError("RED export must be a JSON object or array")

    role = str(payload.get("role") or "").strip().lower()
    if role == "blue":
        raise BridgeError("Expected a RED export, but input JSON has role='blue'")

    defaults = {
        "paper_id": _extract_paper_id(payload, fallback_paper_id),
        "team": str(_first_non_empty(payload, ("team", "teamId", "author"), "red-workbench")).strip(),
        "attack_types": _first_non_empty(payload, ("attackTypes", "attack_types"), ()),
    }

    container = payload.get("red") if isinstance(payload.get("red"), dict) else payload
    for key in ("items", "attacks", "proposals", "edits", "visualEdits", "redEdits", "redRecords", "records", "cases", "reviewItems"):
        val = container.get(key)
        if isinstance(val, list):
            return [x for x in val if isinstance(x, dict)], defaults

    if any(k in payload for k in ("before", "after", "patch", "diff", "unifiedDiff")):
        return [payload], defaults
    raise BridgeError("Could not locate RED attacks, proposals, or visual edits in input JSON")


def _resolve_red_patch_fields(item: dict[str, Any], paper_id: str, case_id: str) -> tuple[str, str, str]:
    raw_patch = _first_non_empty(item, ("patch", "diff", "unifiedDiff"))
    source_map = item.get("change") if isinstance(item.get("change"), dict) else item
    before = _stringify_fragment(_first_non_empty(source_map, ("before", "original", "oldText", "targetBefore"), ""))
    after = _stringify_fragment(
        _first_non_empty(source_map, ("after", "tampered", "newText", "targetAfter", "replacement"), "")
    )
    if raw_patch and HUNK_HEADER_RE.search(str(raw_patch)):
        patch = str(raw_patch)
        if not before and not after:
            before, after = _extract_before_after_from_diff(patch)
        return before, after, patch
    if before or after:
        return before, after, build_unified_diff(before, after, paper_id)
    raise BridgeError(f"RED item {case_id!r} is missing both unified diff patch and before/after fragments")


def _normalize_red_item(
    item: dict[str, Any],
    index: int,
    defaults: dict[str, Any],
    *,
    defect_override: str | None = None,
    detector_spec: str = "",
) -> RedAttackRecord:
    paper_id = str(_first_non_empty(item, ("paperId", "paper_id", "documentId"), defaults["paper_id"])).strip()
    team = str(_first_non_empty(item, ("team", "teamId", "author"), defaults["team"])).strip()
    case_id = str(_first_non_empty(item, ("caseId", "case_id", "id", "proposalId"), f"{paper_id}-red-{index:02d}")).strip()
    dtype = infer_defect_type(item, default_attack_types=defaults.get("attack_types", ()), override=defect_override)
    before, after, patch = _resolve_red_patch_fields(item, paper_id, case_id)

    page_index = _coerce_int(_first_non_empty(item, ("pageIndex", "page_index", "page")))
    location = format_location(item, case_id)
    rationale = _clean_single_line(_stringify_fragment(_first_non_empty(item, ("rationale", "whyHard", "why_hard", "notes", "reason"), "")))
    how_to_catch = _clean_single_line(_stringify_fragment(_first_non_empty(item, ("howToCatch", "how_to_catch", "verificationHint"), "")))
    intended_label = normalize_verdict(str(_first_non_empty(item, ("intendedLabel", "intended_label"), VERDICT_DEFECT)))

    quote_raw = _stringify_fragment(_first_non_empty(item, ("targetQuote", "target_quote"), "")) or after or f"[EDITED:{location}]"
    target_quote = _clean_single_line(quote_raw)
    check_no_answer_key_leakage(target_quote, field_name=f"{case_id}.target_quote")

    det_spec = str(_first_non_empty(item, ("detector_spec", "detectorSpec", "custom_detector"), detector_spec)).strip()
    if dtype not in DEFECT_TYPES and not det_spec:
        det_spec = f"Workbench custom detector for {dtype}"

    return RedAttackRecord(
        case_id=case_id,
        paper_id=paper_id,
        team=team,
        defect_type=dtype,
        location=location,
        page_index=page_index,
        before=before,
        after=after,
        patch=patch,
        target_quote=target_quote,
        intended_label=intended_label,
        rationale=rationale,
        how_to_catch=how_to_catch,
        detector_spec=det_spec,
    )


def _apply_red_edits_to_document(document_text: str | None, records: Sequence[RedAttackRecord]) -> str:
    if document_text is None:
        return "\n".join(r.after or r.target_quote for r in records) + "\n"

    current = document_text
    for rec in records:
        try:
            current = apply_patch.apply_unified_diff(current, rec.patch)
            continue
        except (apply_patch.PatchError, ValueError):
            pass
        if rec.before and rec.before in current:
            current = current.replace(rec.before, rec.after, 1)
            continue
        raise BridgeError(f"Could not apply RED edit {rec.case_id!r} to source document")
    return current


def assert_blind_artifact_clean(text: str, records: Sequence[RedAttackRecord], *, source_document: str | None = None) -> None:
    """Verify the blind Blue target artifact contains zero Red metadata or answer keys."""
    check_no_answer_key_leakage(text, field_name="blind_target")
    for pat in EXTRA_BLIND_LEAKAGE_PATTERNS:
        if pat.search(text):
            raise BridgeError(f"Blind artifact contains forbidden Red metadata ({pat.pattern!r})")
    for rec in records:
        if rec.rationale and len(rec.rationale) >= 12:
            if rec.rationale in text and (source_document is None or rec.rationale not in source_document):
                raise BridgeError(f"Blind artifact leaked Red rationale for {rec.case_id!r}")


def _record_to_submission_dict(rec: RedAttackRecord, blind_ref: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": "falsify.red_submission/1.0",
        "submission_type": "red_attack",
        "case_id": rec.case_id,
        "paper_id": rec.paper_id,
        "team": rec.team,
        "defect_type": rec.defect_type,
        "location": rec.location,
        "target_quote": rec.target_quote,
        "patch": rec.patch,
        "intended_label": rec.intended_label,
        "blind_input": blind_ref,
    }
    if rec.detector_spec:
        payload["detector_spec"] = rec.detector_spec
    if rec.page_index is not None:
        payload["page_index"] = rec.page_index
    if rec.rationale:
        payload["why_hard"] = rec.rationale
    if rec.how_to_catch:
        payload["how_to_catch"] = rec.how_to_catch
    return payload


def _write_answer_key_csv(path: pathlib.Path, records: Sequence[RedAttackRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(ANSWER_KEY_COLUMNS))
        writer.writeheader()
        for rec in records:
            writer.writerow({
                "case_id": rec.case_id,
                "paper_id": rec.paper_id,
                "team": rec.team,
                "defect_type": rec.defect_type,
                "label": rec.intended_label,
                "location": rec.location,
                "page_index": "" if rec.page_index is None else str(rec.page_index),
                "before": rec.before,
                "after": rec.after,
                "rationale": rec.rationale,
                "patch": rec.patch,
            })


def _write_score_keys(keys_dir: pathlib.Path, records: Sequence[RedAttackRecord]) -> list[pathlib.Path]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for rec in records:
        grouped.setdefault(rec.paper_id, []).append({
            "case_id": rec.case_id,
            "paper_id": rec.paper_id,
            "team": rec.team,
            "defect_type": rec.defect_type,
            "location": rec.location,
            "before": rec.before,
            "after": rec.after,
            "page_index": rec.page_index,
            "rationale": rec.rationale,
            "iterations": 1,
            "self_check_model": "workbench",
            "patch_v1": rec.patch,
            "patch_final": rec.patch,
            "why_hard": rec.rationale,
        })
    written: list[pathlib.Path] = []
    for pid, items in sorted(grouped.items()):
        out_path = keys_dir / f"{pid}.json"
        write_json(out_path, items)
        written.append(out_path)
    return written


def _resolve_submission_path(
    rec: RedAttackRecord,
    idx: int,
    total: int,
    submissions_dir: pathlib.Path,
    submission_out: pathlib.Path | None,
) -> pathlib.Path:
    if submission_out and (total == 1 or idx == 0):
        return pathlib.Path(submission_out)
    if total == 1:
        return submissions_dir / "red_submission.json"
    safe_cid = re.sub(r"[^A-Za-z0-9_.-]+", "_", rec.case_id)
    return submissions_dir / f"{safe_cid}.json"


def _write_red_submissions(
    records: Sequence[RedAttackRecord],
    submissions_dir: pathlib.Path,
    blind_path: pathlib.Path,
    submission_out: pathlib.Path | None,
) -> list[pathlib.Path]:
    written: list[pathlib.Path] = []
    for idx, rec in enumerate(records):
        target = _resolve_submission_path(rec, idx, len(records), submissions_dir, submission_out)
        rel_blind = os.path.relpath(blind_path.resolve(), start=target.resolve().parent).replace("\\", "/")
        write_json(target, _record_to_submission_dict(rec, rel_blind))
        validate_path(target)
        written.append(target)
    return written


def convert_red_to_submission(
    input_path: pathlib.Path | dict[str, Any] | list[Any],
    out_dir: pathlib.Path,
    *,
    paper_id: str | None = None,
    defect_type: str | None = None,
    detector_spec: str = "",
    document_path: pathlib.Path | None = None,
    submission_out: pathlib.Path | None = None,
    blind_out: pathlib.Path | None = None,
    answer_key_out: pathlib.Path | None = None,
    keys_dir: pathlib.Path | None = None,
) -> dict[str, Any]:
    """Convert a Workbench RED export into validated submission JSONs, blind artifact, and answer key."""
    payload, fallback_pid = _load_payload_with_fallback(input_path, paper_id)
    items, defaults = _extract_red_items(payload, fallback_pid)
    if paper_id:
        defaults["paper_id"] = paper_id
    if not items:
        raise BridgeError("RED export contains 0 attack records")

    records = [
        _normalize_red_item(item, idx, defaults, defect_override=defect_type, detector_spec=detector_spec)
        for idx, item in enumerate(items, 1)
    ]

    doc_text = document_path.read_text(encoding="utf-8") if document_path else None
    blind_text = _apply_red_edits_to_document(doc_text, records)
    assert_blind_artifact_clean(blind_text, records, source_document=doc_text)

    out_root = pathlib.Path(out_dir)
    blind_path = pathlib.Path(blind_out) if blind_out else out_root / "blind" / f"{records[0].paper_id}.blind.md"
    atomic_write_text(blind_path, blind_text)

    submission_files = _write_red_submissions(records, out_root / "submissions", blind_path, submission_out)
    ak_csv_path = pathlib.Path(answer_key_out) if answer_key_out else out_root / "organizer" / "answer_key.csv"
    _write_answer_key_csv(ak_csv_path, records)

    resolved_keys_dir = pathlib.Path(keys_dir) if keys_dir else out_root / "organizer" / "keys"
    key_files = _write_score_keys(resolved_keys_dir, records)

    return {
        "count": len(records),
        "submission_files": [str(p) for p in submission_files],
        "blind_file": str(blind_path),
        "answer_key_csv": str(ak_csv_path),
        "keys_dir": str(resolved_keys_dir),
        "key_files": [str(p) for p in key_files],
        "records": records,
    }


def _extract_blue_items(payload: Any, fallback_paper_id: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Extract BLUE findings and defaults from supported Workbench BLUE exports."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)], {"paper_id": fallback_paper_id, "team": "blue-workbench"}
    if not isinstance(payload, dict):
        raise BridgeError("BLUE export must be a JSON object or array")

    role = str(payload.get("role") or "").strip().lower()
    if role == "red":
        raise BridgeError("Expected a BLUE export, but input JSON has role='red'")

    defaults = {
        "paper_id": _extract_paper_id(payload, fallback_paper_id),
        "team": str(_first_non_empty(payload, ("team", "teamId"), "blue-workbench")).strip(),
        "judge_type": str(_first_non_empty(payload, ("judgeType", "judge_type"), "model")).strip(),
        "model": str(_first_non_empty(payload, ("model", "modelName", "harness"), "workbench-blue")).strip(),
        "iteration": _coerce_int(_first_non_empty(payload, ("iteration", "round"), 1)) or 1,
        "is_holdout": _coerce_bool(_first_non_empty(payload, ("isHoldout", "is_holdout"), False)),
    }

    container = payload.get("blue") if isinstance(payload.get("blue"), dict) else payload
    for key in ("findings", "results", "items", "verdicts", "checks", "reviews", "cases"):
        val = container.get(key)
        if isinstance(val, list):
            return [x for x in val if isinstance(x, dict)], defaults

    if any(k in payload for k in ("severity", "status", "verdict", "defectDetected")):
        return [payload], defaults
    raise BridgeError("Could not locate BLUE findings in input JSON")


def map_blue_verdict(item: dict[str, Any]) -> str:
    """Deterministically map Workbench BLUE severity/status/verdict to Season 13 verdicts."""
    status = str(_first_non_empty(item, ("status", "decision", "outcome", "state"), "")).strip().lower()
    verdict_raw = str(_first_non_empty(item, ("verdict", "label"), "")).strip().lower()
    severity = str(_first_non_empty(item, ("severity", "level"), "")).strip().lower()

    for token in (status, verdict_raw):
        if token in UNCERTAIN_STATUSES:
            return VERDICT_NEEDS_REVIEW
    for token in (status, verdict_raw):
        if token in DEFECT_STATUSES:
            return VERDICT_DEFECT
    for token in (status, verdict_raw):
        if token in CLEAN_STATUSES:
            return VERDICT_VALID

    defect_flag = _first_non_empty(item, ("defectDetected", "defect_detected", "hasDefect", "discrepant", "isDefect"))
    if isinstance(defect_flag, bool):
        return VERDICT_DEFECT if defect_flag else VERDICT_VALID

    if severity in DEFECT_SEVERITIES:
        return VERDICT_DEFECT
    if severity in CLEAN_SEVERITIES:
        return VERDICT_VALID
    return VERDICT_NEEDS_REVIEW


def _normalize_confidence(raw_val: Any, verdict: str, severity: str) -> float:
    if raw_val is not None and not isinstance(raw_val, bool):
        val = _coerce_float(raw_val, -1.0)
        if 1.0 < val <= 100.0:
            val /= 100.0
        if 0.0 <= val <= 1.0:
            return round(val, 4)
    if verdict == VERDICT_DEFECT:
        return 0.9 if severity in {"critical", "error"} else 0.8
    if verdict == VERDICT_VALID:
        return 0.85
    return 0.5


def _normalize_blue_item(item: dict[str, Any], index: int, defaults: dict[str, Any]) -> BlueFindingRecord:
    paper_id = str(_first_non_empty(item, ("paperId", "paper_id", "documentId"), defaults["paper_id"])).strip()
    team = str(_first_non_empty(item, ("team", "teamId"), defaults.get("team", "blue-workbench"))).strip()
    case_id = str(_first_non_empty(item, ("caseId", "case_id", "id"), f"{paper_id}-blue-{index:02d}")).strip()
    dtype = infer_defect_type(item)
    location = format_location(item, case_id)
    verdict = map_blue_verdict(item)
    severity = str(_first_non_empty(item, ("severity", "level"), "")).strip().lower()
    confidence = _normalize_confidence(_first_non_empty(item, ("confidence", "score")), verdict, severity)

    quote = _clean_single_line(_stringify_fragment(_first_non_empty(item, ("evidenceQuote", "evidence_quote", "quote", "targetQuote"), "")))
    reason = _clean_single_line(_stringify_fragment(_first_non_empty(item, ("evidence", "reason", "message", "explanation", "rationale"), "")))
    evidence_quote = quote or reason or f"[{verdict}] {location}"
    evidence = reason or quote or evidence_quote

    return BlueFindingRecord(
        case_id=case_id,
        paper_id=paper_id,
        team=team,
        judge_type=str(_first_non_empty(item, ("judgeType", "judge_type"), defaults.get("judge_type", "model"))).strip(),
        model=str(_first_non_empty(item, ("model", "modelName", "harness"), defaults.get("model", "workbench-blue"))).strip(),
        iteration=max(1, _coerce_int(_first_non_empty(item, ("iteration", "round"), defaults.get("iteration", 1))) or 1),
        location=location,
        defect_type=dtype,
        verdict=verdict,
        confidence=confidence,
        evidence_quote=evidence_quote,
        evidence=evidence,
        time_sec=max(0.0, _coerce_float(_first_non_empty(item, ("timeSec", "time_sec"), 0.0), 0.0)),
        tokens=max(0, _coerce_int(_first_non_empty(item, ("tokens",), 0)) or 0),
        is_holdout=_coerce_bool(_first_non_empty(item, ("isHoldout", "is_holdout"), defaults.get("is_holdout", False))),
    )


def _deduplicate_blue_records(records: Sequence[BlueFindingRecord]) -> list[BlueFindingRecord]:
    priority = {VERDICT_DEFECT: 3, VERDICT_NEEDS_REVIEW: 2, VERDICT_VALID: 1}
    chosen: dict[tuple[str, str, int, str, str], BlueFindingRecord] = {}
    seen_cids: set[str] = set()

    for rec in records:
        key = (rec.paper_id, rec.team, rec.iteration, rec.location, rec.defect_type.upper())
        prev = chosen.get(key)
        if prev is None or (priority[rec.verdict], rec.confidence) > (priority[prev.verdict], prev.confidence):
            chosen[key] = rec

    deduped: list[BlueFindingRecord] = []
    for idx, rec in enumerate(chosen.values(), 1):
        cid = rec.case_id
        if cid in seen_cids:
            cid = f"{cid}-{idx:02d}"
        seen_cids.add(cid)
        deduped.append(BlueFindingRecord(**{**rec.__dict__, "case_id": cid}))
    return deduped


def _blue_record_to_row(rec: BlueFindingRecord) -> dict[str, str]:
    finding = GateFinding(
        case_id=rec.case_id,
        defect_type=rec.defect_type,
        verdict=rec.verdict,
        confidence=rec.confidence,
        reason=rec.evidence,
        location=rec.location,
        paper_id=rec.paper_id,
    )
    row = finding.to_score_row(
        team=rec.team,
        judge_type=rec.judge_type,
        model=rec.model,
        iteration=rec.iteration,
        time_sec=rec.time_sec,
        tokens=rec.tokens,
        is_holdout=rec.is_holdout,
        defect_perspective=True,
    )
    row["case_id"] = rec.case_id
    row["verdict"] = rec.verdict
    row["confidence"] = f"{rec.confidence:.4f}"
    row["evidence_quote"] = rec.evidence_quote
    return row


def _apply_blue_overrides(defaults: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    merged = dict(defaults)
    for key, val in overrides.items():
        if val is not None:
            merged[key] = val
    return merged


def convert_blue_to_predictions(
    input_path: pathlib.Path | dict[str, Any] | list[Any],
    output_csv: pathlib.Path,
    *,
    paper_id: str | None = None,
    team: str | None = None,
    model: str | None = None,
    iteration: int | None = None,
    is_holdout: bool | None = None,
) -> dict[str, Any]:
    """Convert Workbench BLUE findings JSON into a validated ``tools/score.py`` CSV."""
    payload, fallback_pid = _load_payload_with_fallback(input_path, paper_id)
    items, defaults = _extract_blue_items(payload, fallback_pid)
    if not items:
        raise BridgeError("BLUE export contains 0 findings")

    defaults = _apply_blue_overrides(
        defaults,
        paper_id=paper_id,
        team=team,
        model=model,
        iteration=iteration,
        is_holdout=is_holdout,
    )
    raw_records = [_normalize_blue_item(item, idx, defaults) for idx, item in enumerate(items, 1)]
    records = _deduplicate_blue_records(raw_records)

    out_path = pathlib.Path(output_csv)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(PREDICTION_COLUMNS))
        writer.writeheader()
        for rec in records:
            writer.writerow(_blue_record_to_row(rec))

    validated_rows = validate_blue_csv(out_path)
    return {
        "output_csv": str(out_path),
        "rows": validated_rows,
        "defects_detected": sum(1 for r in records if r.verdict == VERDICT_DEFECT),
        "clean_verified": sum(1 for r in records if r.verdict == VERDICT_VALID),
        "needs_review": sum(1 for r in records if r.verdict == VERDICT_NEEDS_REVIEW),
        "records": records,
    }


def _build_self_test_fixtures() -> tuple[dict[str, Any], dict[str, Any]]:
    red_payload = {
        "schema": "falsify.external-batch.v1",
        "role": "red",
        "paperId": "PMC9000001",
        "team": "red-workbench",
        "items": [
            {
                "caseId": "PMC9000001-d1",
                "attackTypes": ["D1"],
                "kind": "table-cell",
                "pageIndex": 2,
                "location": "L18",
                "before": "Mean reduction was 12.36 points.",
                "after": "Mean reduction was 14.36 points.",
                "rationale": "Digit transposition remains plausible within 95% CI.",
            }
        ],
    }
    blue_payload = {
        "schema": "falsify.external-batch.v1",
        "role": "blue",
        "paperId": "PMC9000001",
        "team": "blue-workbench",
        "findings": [
            {
                "caseId": "PMC9000001-d1",
                "defectType": "D1",
                "location": "L18",
                "severity": "critical",
                "status": "discrepant",
                "confidence": 0.94,
                "evidenceQuote": "Mean reduction was 14.36 points.",
                "evidence": "Prose 14.36 conflicts with Table 2 value 12.36.",
            }
        ],
    }
    return red_payload, blue_payload


def run_roundtrip_check(
    red_input: pathlib.Path | dict[str, Any] | None = None,
    blue_input: pathlib.Path | dict[str, Any] | None = None,
    *,
    papers_csv: pathlib.Path | None = None,
    document_path: pathlib.Path | None = None,
    work_dir: pathlib.Path | None = None,
) -> dict[str, Any]:
    """Run end-to-end validation with ``validate_submission.py`` and ``tools/score.py``."""
    if (red_input is None) != (blue_input is None):
        raise BridgeError("Provide both --red and --blue inputs, or use --self-test")
    if red_input is None and blue_input is None:
        red_input, blue_input = _build_self_test_fixtures()

    def _run_in_dir(root: pathlib.Path) -> dict[str, Any]:
        red_out = root / "red_bundle"
        red_res = convert_red_to_submission(red_input, red_out, document_path=document_path)
        validated_subs = validate_path(red_out / "submissions")

        blind_text = pathlib.Path(red_res["blind_file"]).read_text(encoding="utf-8")
        doc_text = document_path.read_text(encoding="utf-8") if document_path else None
        assert_blind_artifact_clean(blind_text, red_res["records"], source_document=doc_text)

        blue_dir = root / "blue_results"
        pred_csv = blue_dir / "predictions.csv"
        blue_res = convert_blue_to_predictions(blue_input, pred_csv)
        validated_blue_rows = validate_blue_csv(pred_csv)

        score_result = score.score_dir(blue_dir, pathlib.Path(red_res["keys_dir"]), papers_csv)
        return {
            "ok": True,
            "red_submissions_validated": len(validated_subs),
            "blue_rows_validated": validated_blue_rows,
            "blind_leakage_free": True,
            "overall_score": score_result["overall"],
            "papers": score_result["papers"],
        }

    if work_dir is not None:
        return _run_in_dir(pathlib.Path(work_dir))
    with tempfile.TemporaryDirectory(prefix="falsify-bridge-") as tmp:
        return _run_in_dir(pathlib.Path(tmp))


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Bridge Shinick-Han/falsify-workbench exports to Pseudo-Lab/Falsify Season 13 formats"
    )
    sub = ap.add_subparsers(dest="command", required=True)

    p_red = sub.add_parser("red-to-submission", help="Convert Workbench RED JSON to Red submission & organizer sidecars")
    p_red.add_argument("input", help="Workbench RED export JSON path")
    p_red.add_argument("--out-dir", default="work/workbench_red", help="Output bundle directory")
    p_red.add_argument("--paper-id", default=None, help="Override paper_id")
    p_red.add_argument("--defect-type", default=None, help="Override defect_type (D1/D2/D3 or custom)")
    p_red.add_argument("--detector-spec", default="", help="Detector specification for custom defect types")
    p_red.add_argument("--document", default=None, help="Optional source Markdown document to patch for blind output")
    p_red.add_argument("--submission-out", default=None, help="Optional explicit Red submission JSON output path")
    p_red.add_argument("--blind-out", default=None, help="Optional explicit blind target file path")
    p_red.add_argument("--answer-key-out", default=None, help="Optional explicit answer_key.csv output path")
    p_red.add_argument("--keys-dir", default=None, help="Optional explicit score.py keys JSON directory")

    p_blue = sub.add_parser("blue-to-predictions", help="Convert Workbench BLUE JSON to score.py predictions.csv")
    p_blue.add_argument("input", help="Workbench BLUE export JSON path")
    p_blue.add_argument("-o", "--output", required=True, help="Destination predictions.csv path")
    p_blue.add_argument("--paper-id", default=None, help="Override paper_id")
    p_blue.add_argument("--team", default=None, help="Override Blue team identifier")
    p_blue.add_argument("--model", default=None, help="Override model/harness identifier")
    p_blue.add_argument("--iteration", type=int, default=None, help="Override iteration number (>= 1)")
    p_blue.add_argument("--holdout", action="store_true", help="Mark rows as holdout")

    p_rt = sub.add_parser("roundtrip-check", help="Validate end-to-end compatibility with validate_submission.py and score.py")
    p_rt.add_argument("--red", default=None, help="Workbench RED export JSON path")
    p_rt.add_argument("--blue", default=None, help="Workbench BLUE export JSON path")
    p_rt.add_argument("--papers", default=None, help="Optional corpus/papers.csv")
    p_rt.add_argument("--document", default=None, help="Optional source Markdown document")
    p_rt.add_argument("--work-dir", default=None, help="Optional directory to keep generated artifacts")
    p_rt.add_argument("--self-test", action="store_true", help="Run built-in synthetic roundtrip check")
    return ap


def _opt_path(raw: str | None) -> pathlib.Path | None:
    return pathlib.Path(raw) if raw else None


def _cmd_red(args: argparse.Namespace) -> dict[str, Any]:
    res = convert_red_to_submission(
        pathlib.Path(args.input),
        pathlib.Path(args.out_dir),
        paper_id=args.paper_id,
        defect_type=args.defect_type,
        detector_spec=args.detector_spec,
        document_path=_opt_path(args.document),
        submission_out=_opt_path(args.submission_out),
        blind_out=_opt_path(args.blind_out),
        answer_key_out=_opt_path(args.answer_key_out),
        keys_dir=_opt_path(args.keys_dir),
    )
    return {k: v for k, v in res.items() if k != "records"}


def _cmd_blue(args: argparse.Namespace) -> dict[str, Any]:
    res = convert_blue_to_predictions(
        pathlib.Path(args.input),
        pathlib.Path(args.output),
        paper_id=args.paper_id,
        team=args.team,
        model=args.model,
        iteration=args.iteration,
        is_holdout=True if args.holdout else None,
    )
    return {k: v for k, v in res.items() if k != "records"}


def _cmd_roundtrip(args: argparse.Namespace) -> dict[str, Any]:
    if not args.self_test and (not args.red or not args.blue):
        raise BridgeError("roundtrip-check requires --red and --blue, or --self-test")
    return run_roundtrip_check(
        _opt_path(args.red),
        _opt_path(args.blue),
        papers_csv=_opt_path(args.papers),
        document_path=_opt_path(args.document),
        work_dir=_opt_path(args.work_dir),
    )


CLI_HANDLERS = {
    "red-to-submission": _cmd_red,
    "blue-to-predictions": _cmd_blue,
    "roundtrip-check": _cmd_roundtrip,
}


def main(argv: Sequence[str] | None = None) -> int:
    ap = _build_parser()
    args = ap.parse_args(list(argv) if argv is not None else None)
    try:
        summary = CLI_HANDLERS[args.command](args)
    except (BridgeError, SubmissionValidationError, score.SchemaError, OSError, json.JSONDecodeError) as exc:
        print(f"BRIDGE FAILED: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
