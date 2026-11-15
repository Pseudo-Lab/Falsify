"""Pure BLUE report validation: verbatim quote gate, Zero-Drop restoration, 12-column CSV.

Schema: ``falsify.blue-report-validation.v1``.

The module is deliberately side-effect free except for an explicit ``csv_path``
argument, so the CLI stays a thin JSON envelope around testable functions.

Zero-Drop semantics are a faithful Python port of
``app/dist/blue-defect-sensor-core.js`` (``partitionStage2`` /
``entryMatchesFinding`` / ``reconcileCandidateLedger``). The JavaScript file is
never imported or executed.
"""
from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from pathlib import Path

import pymupdf

from paper_supplement_audit import _FORBIDDEN_RED_KEYS
from paper_text_span_mutator import (
    _extract_page_lines,
    _line_similarity,
    _nearest_line_candidates,
)

SCHEMA = "falsify.blue-report-validation.v1"
CSV_COLUMNS = (
    "paper_id", "team", "judge_type", "model", "iteration",
    "location", "defect_type", "label", "evidence", "time_sec", "tokens", "is_holdout",
)
DEFECT_FAMILIES = frozenset({"D1", "D2", "D3", "D4", "D5", "D6", "D7", "D4-1", "S1"})
MAX_FINDINGS = 5000
MAX_SCAN_PAGES = 400
MAX_LEDGER_ENTRIES = 5000
MAX_WARNINGS = 50
MIN_QUOTE_CHARS = 3
FALLBACK_FAMILY = "D3"
QUOTE_FIELDS = ("quote", "excerpt", "resolutionQuote")
FAMILY_FIELDS = ("family", "findingType", "defect_type", "defectFamily")
FORMULA_PREFIXES = ("=", "+", "-", "@")
VERDICT_VOCABULARY = (
    "아님", "맞음", "확인필요",
    "defect", "supported", "supported-in-source", "unsupported",
    "needs_check", "needs-verification", "uncertain",
)
RECOVERY_HINT_VOCABULARY = (
    "Accepted verdictLabel/verdict values: "
    + ", ".join(VERDICT_VOCABULARY)
    + " (case-insensitive)."
)

_VERDICT_ALIASES = {
    "맞음": "맞음",
    "supported": "맞음",
    "supported-in-source": "맞음",
    "아님": "아님",
    "defect": "아님",
    "unsupported": "아님",
    "확인필요": "확인필요",
    "needs-verification": "확인필요",
    "needs-check": "확인필요",
    "needs_check": "확인필요",
    "uncertain": "확인필요",
}
_WS_RE = re.compile(r"\s+")
_FAMILY_SPLIT_RE = re.compile(r"[\s:/(]")
_SOFT_HYPHEN = "\u00ad"


class BlueReportError(ValueError):
    """Structured validation failure carrying a CLI code, exit code and recovery hint."""

    def __init__(self, code: str, message: str, *, exit_code: int = 2,
                 recovery_hint: str = "", extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.recovery_hint = recovery_hint
        self.extra = dict(extra or {})


def _fail(code: str, message: str, *, exit_code: int = 2, recovery_hint: str = "",
          extra: dict | None = None):
    raise BlueReportError(code, message, exit_code=exit_code,
                          recovery_hint=recovery_hint, extra=extra)


# --------------------------------------------------------------------------- text


def collapse_ws(value) -> str:
    """Collapse every whitespace run (including soft hyphens) into single spaces."""
    return _WS_RE.sub(" ", str(value or "").replace(_SOFT_HYPHEN, "")).strip()


def normalize_verdict_label(raw) -> str:
    """Map a verdictLabel/verdict alias onto 아님/맞음/확인필요 (empty when unknown)."""
    return _VERDICT_ALIASES.get(collapse_ws(raw).lower(), "")


def has_resolution_basis(finding: dict) -> bool:
    """True when a 맞음 verdict carries an explicit resolution quote or non-empty rationale."""
    quote = finding.get("resolutionQuote")
    if isinstance(quote, str) and quote.strip():
        return True
    rationale = finding.get("rationale")
    return isinstance(rationale, str) and bool(rationale.strip())


def finding_quote(finding: dict) -> str:
    """First non-empty quote-ish field of a finding (quote, excerpt, resolutionQuote)."""
    for key in QUOTE_FIELDS:
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def finding_id(finding: dict, index: int) -> str:
    """Stable identifier for reporting: id, reportNumber, candidateId, else positional."""
    for key in ("id", "reportNumber", "candidateId"):
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return f"finding-{index + 1}"


def declared_page_index(finding: dict) -> int | None:
    """0-based page scope declared by a finding (pageIndex wins, then 1-based page)."""
    idx = finding.get("pageIndex")
    if type(idx) is int and idx >= 0:
        return idx
    page = finding.get("page")
    if type(page) is int and page > 0:
        return page - 1
    return None


def _norm_quote(value) -> str:
    return collapse_ws(value).lower()


def quote_overlaps12(first, second) -> bool:
    """True when two normalized quotes share a >=12 character verbatim window."""
    left, right = _norm_quote(first), _norm_quote(second)
    if len(left) < 12 or len(right) < 12:
        return False
    if left in right or right in left:
        return True
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    return any(shorter[pos:pos + 12] in longer for pos in range(0, len(shorter) - 11))


def _page_number(obj) -> int | None:
    page = obj.get("page")
    if type(page) is int and page > 0:
        return page
    idx = obj.get("pageIndex")
    return idx + 1 if type(idx) is int and idx >= 0 else None


def _location_matches(first, second) -> bool:
    left_page, right_page = _page_number(first), _page_number(second)
    if left_page is None or right_page is None or left_page != right_page:
        return False
    left, right = _norm_quote(first.get("locationLabel")), _norm_quote(second.get("locationLabel"))
    if not left or not right:
        return False
    return left == right or left in right or right in left


def entry_matches_finding(entry: dict, finding: dict) -> bool:
    """Zero-Drop identity match: candidate id, then 12-char quote overlap, then page+label."""
    entry_id = collapse_ws(entry.get("candidateId") or entry.get("id")).lower()
    finding_id_value = collapse_ws(
        finding.get("candidateId") or finding.get("id") or finding.get("reportNumber")
    ).lower()
    if entry_id and finding_id_value and entry_id == finding_id_value:
        return True
    if quote_overlaps12(entry.get("quote"), finding.get("quote")):
        return True
    return _location_matches(entry, finding)


def build_recovered_finding(entry: dict, index: int) -> dict:
    """Restore a dropped stage-1 candidate as an abstained 확인필요 finding."""
    page = _page_number(entry)
    idx = entry.get("pageIndex")
    page_index = idx if type(idx) is int and idx >= 0 else (page - 1 if page else None)
    suspicion = entry.get("suspicion") or entry.get("note") or "원문 재확인 필요"
    recovered = {
        "reportNumber": entry.get("candidateId") or entry.get("id") or f"ZD-{index + 1}",
        "pageIndex": page_index,
        "locationLabel": entry.get("locationLabel") or "",
        "findingType": entry.get("defectFamily") or "확인필요(누락복원)",
        "severity": "불일치",
        "verdictLabel": "확인필요",
        "confidence": "확인필요 (Zero-Drop 복원)",
        "quote": entry.get("quote") or "",
        "rationale": (
            "[Zero-Drop 자동 복원] 1단계 의심 원장에 기록되었으나 2단계 판정에서 "
            f"해소 근거 없이 누락됨: {suspicion}"
        ),
        "zeroDropRecovered": True,
    }
    if page:
        recovered["page"] = page
    return recovered


def recover_unmatched_stage2(item: dict, index: int) -> dict:
    """Downgrade a 맞음 verdict that has no resolution basis back to 확인필요."""
    return {
        **item,
        "reportNumber": (
            item.get("reportNumber") or item.get("candidateId")
            or item.get("id") or f"ZD-S2-{index + 1}"
        ),
        "findingType": item.get("findingType") or item.get("defectFamily") or "확인필요(누락복원)",
        "severity": item.get("severity") or "불일치",
        "verdictLabel": "확인필요",
        "confidence": item.get("confidence") or "확인필요 (Zero-Drop 복원)",
        "rationale": (
            "[Zero-Drop 자동 복원] 2단계에서 맞음 판정되었으나 "
            "해소 근거가 없어 확인필요로 복원됨."
        ),
        "zeroDropRecovered": True,
    }


def partition_stage2(raw_findings) -> dict:
    """Split stage-2 findings into defects, basis-backed resolutions and invalid ones."""
    defects, resolved, invalid = [], [], []
    for raw in raw_findings:
        if not isinstance(raw, dict):
            continue
        verdict = normalize_verdict_label(raw.get("verdictLabel"))
        item = {**raw, "verdictLabel": verdict} if verdict else dict(raw)
        if verdict != "맞음":
            defects.append(item)
        elif has_resolution_basis(item):
            resolved.append(item)
        else:
            invalid.append(item)
    return {"defectFindings": defects, "resolvedOk": resolved, "invalidResolved": invalid}


def reconcile_candidate_ledger(candidate_ledger, findings) -> dict:
    """Restore dropped ledger candidates and unsupported resolutions (Zero-Drop gate)."""
    ledger = [item for item in candidate_ledger if isinstance(item, dict)] \
        if isinstance(candidate_ledger, list) else []
    parts = partition_stage2(findings if isinstance(findings, list) else [])
    valid_targets = parts["defectFindings"] + parts["resolvedOk"]
    recovered = [
        build_recovered_finding(entry, idx)
        for idx, entry in enumerate(ledger)
        if not any(entry_matches_finding(entry, target) for target in valid_targets)
    ]
    recovered.extend(
        recover_unmatched_stage2(item, idx)
        for idx, item in enumerate(parts["invalidResolved"])
        if not any(entry_matches_finding(entry, item) for entry in ledger)
    )
    return {
        "findings": parts["defectFindings"] + recovered,
        "resolvedOk": parts["resolvedOk"],
        "summary": {
            "stage1Count": len(ledger),
            "resolvedOkCount": len(parts["resolvedOk"]),
            "reportedDefectCount": len(parts["defectFindings"]),
            "recoveredCount": len(recovered),
        },
    }


# ------------------------------------------------------------------ PDF text model


def _join_lines(lines: list[dict]) -> tuple[str, list[tuple[int, int]]]:
    """Join ordered page lines into one searchable string plus per-line offsets.

    A line ending with a hyphen followed by a lowercase continuation is treated as a
    soft-hyphen line break: the hyphen is dropped and no space is inserted.
    """
    texts = [collapse_ws(line.get("text")) for line in lines]
    glues = []
    for idx, text in enumerate(texts):
        if idx == 0 or not text:
            glues.append("")
        elif texts[idx - 1].endswith("-") and text[:1].islower():
            texts[idx - 1] = texts[idx - 1][:-1]
            glues.append("")
        else:
            glues.append(" ")
    spans, pieces, cursor = [], [], 0
    for glue, text in zip(glues, texts):
        if not text:
            spans.append((cursor, cursor))
            continue
        cursor += len(glue)
        pieces.append(glue)
        pieces.append(text)
        spans.append((cursor, cursor + len(text)))
        cursor += len(text)
    return "".join(pieces), spans


def _page_records(pdf_bytes: bytes) -> list[dict]:
    records = []
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.needs_pass:
            _fail("invalid_pdf", "PDF is password protected and cannot be text-extracted.",
                  recovery_hint="Provide an unlocked PDF.")
        for idx in range(min(doc.page_count, MAX_SCAN_PAGES)):
            lines = _extract_page_lines(doc[idx], idx)
            text, spans = _join_lines(lines)
            records.append({"pageIndex": idx, "lines": lines, "spans": spans, "text": text})
    return records


def _scoped_pages(pages: list[dict], page_index: int | None) -> list[dict]:
    if page_index is not None and 0 <= page_index < len(pages):
        return [pages[page_index]]
    return pages


def _locate_quote(pages: list[dict], quote: str, page_index: int | None) -> dict | None:
    """Locate a quote inside its declared page (when given) or across all pages."""
    needle = collapse_ws(quote)
    low = needle.lower()
    for page in _scoped_pages(pages, page_index):
        pos = page["text"].find(needle)
        if pos >= 0:
            return {"status": "exact", "page": page, "span": (pos, pos + len(needle))}
    for page in _scoped_pages(pages, page_index):
        pos = page["text"].lower().find(low)
        if pos >= 0:
            return {"status": "normalized", "page": page, "span": (pos, pos + len(low))}
    return None


def _span_bbox(page: dict, span: tuple[int, int]) -> list[float] | None:
    start, end = span
    boxes = [
        line["bbox"]
        for line, (line_start, line_end) in zip(page["lines"], page["spans"])
        if line_end > line_start and line_start < end and line_end > start
    ]
    if not boxes:
        return None
    return [
        round(min(box[0] for box in boxes), 2),
        round(min(box[1] for box in boxes), 2),
        round(max(box[2] for box in boxes), 2),
        round(max(box[3] for box in boxes), 2),
    ]


def _nearest_candidates(pages: list[dict], quote: str, page_index: int | None,
                        limit: int) -> list[dict]:
    """Rank nearest lines with _line_similarity, most relevant page first."""
    needle = collapse_ws(quote)
    scoped = _scoped_pages(pages, page_index)
    ordered = sorted(
        scoped,
        key=lambda page: -max([_line_similarity(needle, line["text"]) for line in page["lines"]] or [0.0]),
    )
    lines = [line for ordering in ordered for line in ordering["lines"]]
    return [
        {"pageIndex": item["pageIndex"], "bbox": item["bbox"], "text": item["text"]}
        for item in _nearest_line_candidates(lines, needle, limit)
    ]


def check_finding_quote(finding: dict, index: int, pages: list[dict],
                        max_candidates: int) -> dict | None:
    """Verify one finding quote exists verbatim; None when the finding carries no quote."""
    quote = finding_quote(finding)
    if len(collapse_ws(quote)) < MIN_QUOTE_CHARS:
        return None
    page_index = declared_page_index(finding)
    located = _locate_quote(pages, quote, page_index)
    if located:
        return {
            "findingId": finding_id(finding, index),
            "quote": quote,
            "status": located["status"],
            "pageIndex": located["page"]["pageIndex"],
            "bbox": _span_bbox(located["page"], located["span"]),
            "nearestCandidates": [],
        }
    return {
        "findingId": finding_id(finding, index),
        "quote": quote,
        "status": "missing",
        "pageIndex": None,
        "bbox": None,
        "nearestCandidates": _nearest_candidates(pages, quote, page_index, max_candidates),
        "recoveryHint": (
            "Quote not found in the PDF text. Re-read the cited page, paste the verbatim "
            "string, or abstain with verdictLabel 확인필요."
        ),
    }


def _quote_check(findings: list[dict], pages: list[dict], max_candidates: int) -> dict:
    quotes, unquoted = [], 0
    for idx, finding in enumerate(findings):
        record = check_finding_quote(finding, idx, pages, max_candidates)
        if record is None:
            unquoted += 1
        else:
            quotes.append(record)
    counts = {status: 0 for status in ("exact", "normalized", "missing")}
    for record in quotes:
        counts[record["status"]] += 1
    return {
        "findingCount": len(findings),
        "checkedCount": len(quotes),
        "unquotedCount": unquoted,
        "exactCount": counts["exact"],
        "normalizedCount": counts["normalized"],
        "missingCount": counts["missing"],
        "quotes": quotes,
    }


# ------------------------------------------------------------------- report shape


def report_findings(report) -> list[dict]:
    """Extract the findings list from a report object or bare array."""
    if isinstance(report, list):
        return list(report)
    if not isinstance(report, dict):
        _fail("invalid_blue_report", "Report must be a JSON object or an array of findings.",
              recovery_hint="Pass a falsify.blue-report.v1 object with a 'findings' array.")
    for key in ("findings", "verdicts"):
        if key not in report:
            continue
        value = report.get(key)
        if not isinstance(value, list):
            _fail("invalid_blue_report",
                  f"Report field '{key}' must be a JSON array of finding objects.",
                  recovery_hint="Emit 'findings': [ {...}, ... ] with one object per claim.")
        return list(value)
    return []


def validate_findings(findings: list, label: str = "finding") -> None:
    """Reject malformed reports: >5000 entries, non-objects, unknown verdict vocabulary."""
    if len(findings) > MAX_FINDINGS:
        _fail("invalid_blue_report",
              f"Report carries {len(findings)} {label} entries; at most {MAX_FINDINGS} are accepted.",
              recovery_hint=f"Split the report into batches of <= {MAX_FINDINGS} findings.")
    for idx, item in enumerate(findings):
        if not isinstance(item, dict):
            _fail("invalid_blue_report",
                  f"{label.capitalize()} #{idx + 1} is {type(item).__name__}, not a JSON object.",
                  recovery_hint=RECOVERY_HINT_VOCABULARY)
        declared = item.get("verdictLabel")
        if declared is None:
            declared = item.get("verdict")
        if declared is not None and not normalize_verdict_label(declared):
            _fail("invalid_blue_report",
                  f"{label.capitalize()} #{idx + 1} has unknown verdict value {declared!r}.",
                  recovery_hint=RECOVERY_HINT_VOCABULARY)


def ledger_entries(ledger) -> list:
    """Accept a ledger array or an object wrapping candidateLedger/candidates/entries."""
    if isinstance(ledger, list):
        return list(ledger)
    if isinstance(ledger, dict):
        for key in ("candidateLedger", "candidates", "entries"):
            value = ledger.get(key)
            if isinstance(value, list):
                return list(value)
    if ledger is None:
        return []
    _fail("invalid_candidate_ledger",
          "candidateLedger must be a JSON array of candidate objects.",
          recovery_hint="Pass a ledger array or {'candidateLedger': [...]}.")


def forbidden_keys(value, prefix: str = "") -> list[str]:
    """Collect dotted paths of forbidden RED/gold keys anywhere in a JSON value."""
    found = []
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if key in _FORBIDDEN_RED_KEYS:
                found.append(path)
            found.extend(forbidden_keys(child, path))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            found.extend(forbidden_keys(item, f"{prefix}[{idx}]"))
    return found


# -------------------------------------------------------------------------- CSV


def _push_warning(warnings: list[str], message: str) -> None:
    if len(warnings) < MAX_WARNINGS and message not in warnings:
        warnings.append(message)


def normalize_family_token(raw) -> str:
    """Whitelist a defect family token (D1..D7, D4-1, S1) or return ''."""
    text = collapse_ws(raw).upper().replace("_", "-").replace(".", "-")
    token = _FAMILY_SPLIT_RE.split(text)[0].strip("-") if text else ""
    return token if token in DEFECT_FAMILIES else ""


def csv_label(finding: dict) -> str:
    """12-column label: 아님 / 맞음 / 확인필요 (Zero-Drop recoveries always 확인필요)."""
    if finding.get("zeroDropRecovered") is True:
        return "확인필요"
    declared = finding.get("verdictLabel")
    if declared is None:
        declared = finding.get("verdict")
    return normalize_verdict_label(declared) or "확인필요"


def csv_defect_type(finding: dict, warnings: list[str]) -> str:
    """Whitelisted defect family with a warned D3 fallback when nothing usable is present."""
    ident = collapse_ws(finding.get("reportNumber") or finding.get("id") or "?")
    seen = False
    for key in FAMILY_FIELDS:
        raw = finding.get(key)
        if not isinstance(raw, str) or not raw.strip():
            continue
        seen = True
        token = normalize_family_token(raw)
        if token:
            return token
        _push_warning(warnings, f"{ident}: unmapped defect family {raw!r}; recorded as {FALLBACK_FAMILY}.")
    if not seen:
        _push_warning(warnings, f"{ident}: missing defect family; recorded as {FALLBACK_FAMILY}.")
    return FALLBACK_FAMILY


def csv_location(finding: dict) -> str:
    """Human-readable location: locationLabel, then 1-based page marker."""
    label = collapse_ws(finding.get("locationLabel"))
    if label:
        return label
    index = declared_page_index(finding)
    return f"p.{index + 1}" if index is not None else ""


def csv_evidence(finding: dict) -> str:
    """Evidence cell: verbatim quote fields plus rationale, de-duplicated, newline joined."""
    parts: list[str] = []
    for key in (*QUOTE_FIELDS, "rationale"):
        value = finding.get(key)
        text = collapse_ws(value) if isinstance(value, str) else ""
        if text and text not in parts:
            parts.append(text)
    return "\n".join(parts)


def _number_cell(value, default: float) -> str:
    if isinstance(value, bool) or value is None:
        return str(default)
    if isinstance(value, (int, float)):
        return str(value) if math.isfinite(float(value)) else str(default)
    text = collapse_ws(value)
    try:
        number = float(text)
    except ValueError:
        return str(default)
    return str(int(number)) if number.is_integer() else str(number)


def csv_holdout(finding: dict, defaults: dict) -> str:
    value = finding.get("is_holdout", finding.get("isHoldout", defaults.get("isHoldout")))
    return "true" if value is True else "false"


def build_csv_rows(findings: list[dict], paper_id: str, defaults: dict | None = None) -> dict:
    """Normalize findings into the canonical 12-column BLUE row shape."""
    defaults = dict(defaults or {})
    warnings: list[str] = []
    rows = []
    for finding in findings:
        rows.append({
            "paper_id": paper_id,
            "team": collapse_ws(defaults.get("team")) or "blue",
            "judge_type": collapse_ws(defaults.get("judgeType")) or "blue",
            "model": collapse_ws(defaults.get("model")) or "unknown",
            "iteration": _number_cell(defaults.get("iteration"), 0),
            "location": csv_location(finding),
            "defect_type": csv_defect_type(finding, warnings),
            "label": csv_label(finding),
            "evidence": csv_evidence(finding),
            "time_sec": _number_cell(finding.get("timeSec", finding.get("time_sec", defaults.get("timeSec"))), 0),
            "tokens": _number_cell(finding.get("tokens", defaults.get("tokens")), 0),
            "is_holdout": csv_holdout(finding, defaults),
        })
    return {"rows": rows, "warnings": warnings}


def neutralize_cell(value) -> tuple[str, bool]:
    """Prefix a leading =, +, - or @ with an apostrophe so spreadsheets keep it literal."""
    text = "" if value is None else str(value)
    if text[:1] in FORMULA_PREFIXES:
        return "'" + text, True
    return text, False


def render_csv(rows: list[dict]) -> dict:
    """Render RFC 4180 CSV text (CRLF, minimal quoting, UTF-8 without BOM)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(CSV_COLUMNS)
    neutralized = 0
    for row in rows:
        cells = []
        for column in CSV_COLUMNS:
            text, changed = neutralize_cell(row.get(column, ""))
            neutralized += 1 if changed else 0
            cells.append(text)
        writer.writerow(cells)
    return {"text": buffer.getvalue(), "neutralizedCells": neutralized}


def write_csv(csv_path: str, rows: list[dict]) -> dict:
    """Write the normalized rows to ``csv_path`` and describe the file."""
    rendered = render_csv(rows)
    target = Path(csv_path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered["text"], encoding="utf-8", newline="")
    except OSError as exc:
        _fail("output_write_failed", f"Unable to write CSV: {exc}",
              recovery_hint="Choose a writable --csv path.")
    return {
        "path": str(target),
        "rowCount": len(rows),
        "columns": list(CSV_COLUMNS),
        "neutralizedCells": rendered["neutralizedCells"],
    }


# --------------------------------------------------------------- entry point


def _report_paper_id(report, fallback: str) -> str:
    if isinstance(report, dict):
        for key in ("paperId", "paper_id"):
            value = report.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return fallback


def _csv_defaults(report) -> dict:
    if not isinstance(report, dict):
        return {}
    return {
        key: report[key]
        for key in ("team", "judgeType", "model", "iteration", "timeSec", "tokens", "isHoldout")
        if key in report
    }


def _require_pdf_bytes(pdf_bytes) -> bytes:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not bytes(pdf_bytes).startswith(b"%PDF-"):
        _fail("invalid_pdf", "pdf_bytes must contain the raw bytes of a %PDF- file.",
              recovery_hint="Provide an uncorrupted PDF starting with %PDF-.")
    return bytes(pdf_bytes)


def _require_max_candidates(max_candidates) -> None:
    if type(max_candidates) is not int or not 1 <= max_candidates <= 20:
        _fail("invalid_arguments", "max_candidates must be an integer between 1 and 20.",
              recovery_hint="Pass max_candidates between 1 and 20.")


def _resolve_ledger_entries(ledger, report) -> list:
    source = ledger if ledger is not None else (
        report.get("candidateLedger") if isinstance(report, dict) else None
    )
    entries = ledger_entries(source)
    if len(entries) > MAX_LEDGER_ENTRIES:
        _fail("invalid_candidate_ledger",
              f"candidateLedger carries {len(entries)} entries; at most {MAX_LEDGER_ENTRIES} are accepted.",
              recovery_hint=f"Keep the ledger at or below {MAX_LEDGER_ENTRIES} entries.")
    return entries


def _guard_red_leaks(report, entries) -> None:
    leaks = forbidden_keys(report) + forbidden_keys(entries)
    if leaks:
        _fail("forbidden_red_key",
              f"BLUE report/ledger contains forbidden RED key(s): {', '.join(leaks[:5])}",
              exit_code=3,
              recovery_hint="Remove RED/gold ledger fields before BLUE validation.",
              extra={"leaks": leaks[:10]})


def _ledger_override_warning(ledger, report) -> list[str]:
    warnings: list[str] = []
    if ledger is not None and isinstance(report, dict) and report.get("candidateLedger"):
        _push_warning(warnings, "Explicit candidateLedger replaced report.candidateLedger.")
    return warnings


def _emit_csv(csv_path, reconciled, paper_identifier, defaults, warnings) -> dict:
    built = build_csv_rows(
        reconciled["findings"] + reconciled["resolvedOk"], paper_identifier, defaults
    )
    for message in built["warnings"]:
        _push_warning(warnings, message)
    return write_csv(csv_path, built["rows"])


def validate_blue_report(pdf_bytes, report, *, ledger=None, csv_path=None,
                         max_candidates: int = 5, paper_id: str | None = None,
                         file_hash: str | None = None) -> dict:
    """Validate a BLUE report against a PDF: quote gate, Zero-Drop restoration, CSV rows."""
    raw = _require_pdf_bytes(pdf_bytes)
    _require_max_candidates(max_candidates)
    findings = report_findings(report)
    validate_findings(findings)
    entries = _resolve_ledger_entries(ledger, report)
    _guard_red_leaks(report, entries)
    reconciled = reconcile_candidate_ledger(entries, findings)
    checks = _quote_check(
        reconciled["findings"] + reconciled["resolvedOk"], _page_records(raw), max_candidates
    )
    digest = file_hash or hashlib.sha256(raw).hexdigest()
    paper_identifier = paper_id or _report_paper_id(report, f"paper-{digest[:12]}")
    warnings = _ledger_override_warning(ledger, report)
    csv_result = None
    if csv_path is not None:
        csv_result = _emit_csv(
            csv_path, reconciled, paper_identifier, _csv_defaults(report), warnings
        )
    return {
        "schema": SCHEMA,
        "ok": checks["missingCount"] == 0,
        "paperId": paper_identifier,
        "fileHash": digest,
        "quoteCheck": checks,
        "zeroDrop": {
            "summary": reconciled["summary"],
            "recoveredFindingIds": [
                str(item.get("reportNumber") or "") for item in reconciled["findings"]
                if item.get("zeroDropRecovered") is True
            ],
        },
        "csv": csv_result,
        "warnings": warnings,
    }
