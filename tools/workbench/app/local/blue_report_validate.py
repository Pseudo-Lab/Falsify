"""Pure BLUE report validation: verbatim quote gate, Zero-Drop restoration, 12-column CSV.

Schema: ``falsify.blue-report-validation.v1``. ``finalize_blue_report`` emits
``falsify.blue-report-finalize.v1`` and a gate-clean ``falsify.blue-report.v1``.

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
import json
import math
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pymupdf

from paper_supplement_audit import _FORBIDDEN_RED_KEYS
from paper_text_span_mutator import (
    _extract_page_lines,
    _line_similarity,
    _nearest_line_candidates,
)

SCHEMA = "falsify.blue-report-validation.v1"
REPAIR_PACK_SCHEMA = "falsify.blue-repair-pack.v1"
FINALIZE_SCHEMA = "falsify.blue-report-finalize.v1"
BLUE_REPORT_SCHEMA = "falsify.blue-report.v1"
AUTO_DOWNGRADE_PREFIX = "[인용 미검증 자동 강등] "
MAX_REPAIR_PACK_BYTES = 16384
_MAX_SUPPLEMENT_ENTRY_BYTES = 25 * 1024 * 1024
_PLAIN_TEXT_EXTS = frozenset({
    ".py", ".r", ".md", ".rmd", ".qmd", ".txt", ".csv", ".tsv", ".json", ".log", ".sql",
})
_JSON_SUPPLEMENT_EXTS = frozenset({".json", ".ipynb"})
_FINAL_REPORT_SKIP = frozenset({
    "findings", "verdicts", "candidateLedger", "resolvedOk", "schema", "candidates", "entries",
})
_LEDGER_SCHEMAS = frozenset({
    "falsify.red-gold-ledger.v1",
    "falsify.coordinated-red-record.v1",
})
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
_TYPO_REPL = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi",
    "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
    "\u2212": "-", "\u2010": "-", "\u2011": "-", "\u2012": "-",
    "\u2013": "-", "\u2014": "-", "\u2015": "-",
    "\u2018": "'", "\u2019": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201f": '"', "\u2033": '"',
    "\u00b5": "\u03bc", "\u00d7": "x", "\u2264": "<=", "\u2265": ">=", "\u2260": "!=",
    "\u00a0": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ",
    "\u200b": "", "\ufeff": "", "\u00ad": "",
}
_WRAP_HYPHENS = frozenset("-\u2010\u2011\u2012\u2013\u2014\u2015\u2212")
_REPAIR_ACTIONS = (
    "replace_quote_with_verbatim_substring",
    "downgrade_verdictLabel_to_확인필요",
)
_REPAIR_PROMPT = (
    "For each missing quote, copy an exact substring from nearestCandidates "
    'or contextWindow into quote, or set verdictLabel to "확인필요".'
)
_LIGATURE_FLAGS = (
    pymupdf.TEXT_MEDIABOX_CLIP
    | pymupdf.TEXT_PRESERVE_LIGATURES
    | pymupdf.TEXT_PRESERVE_WHITESPACE
)


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


def _expand_mapped(value) -> tuple[str, list[int]]:
    """Replace typographic characters and record each output char's source index."""
    chars, origins = [], []
    for idx, ch in enumerate(str(value or "")):
        piece = _TYPO_REPL.get(ch, ch).lower()
        chars.append(piece)
        origins.extend([idx] * len(piece))
    return "".join(chars), origins


def _collapse_mapped(text: str, origins: list[int]) -> tuple[str, list[int]]:
    """Collapse whitespace the way collapse_ws does, keeping source indexes."""
    out, mapped = [], []
    pending = False
    pending_at = 0
    for idx, ch in enumerate(text):
        if ch.isspace():
            pending = True
            pending_at = idx
            continue
        if pending and out:
            out.append(" ")
            mapped.append(origins[pending_at])
        pending = False
        out.append(ch)
        mapped.append(origins[idx])
    return "".join(out), mapped


def fold_typographic(value) -> str:
    """Fold ligatures, dashes, quotes, and math symbols, then collapse and lowercase."""
    text, _origins = _collapse_mapped(*_expand_mapped(value))
    return text


def _windows_overlap(left: str, right: str) -> bool:
    """True when two strings share a >=12 character verbatim window."""
    if len(left) < 12 or len(right) < 12:
        return False
    if left in right or right in left:
        return True
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    return any(shorter[pos:pos + 12] in longer for pos in range(0, len(shorter) - 11))


def quote_overlaps12(first, second) -> bool:
    """True when two quotes share a >=12 character window, after typographic folding."""
    if _windows_overlap(_norm_quote(first), _norm_quote(second)):
        return True
    return _windows_overlap(fold_typographic(first), fold_typographic(second))


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


def _ends_wrap_hyphen(text: str) -> bool:
    return bool(text) and text[-1] in _WRAP_HYPHENS


def _soft_wrap_flags(texts: list[str]) -> list[bool]:
    """Mark line-end hyphens whose next lowercase fragment continues the word."""
    flags = [False] * len(texts)
    nxt = ""
    for idx in range(len(texts) - 1, -1, -1):
        text = texts[idx]
        if text and nxt and _ends_wrap_hyphen(text) and nxt[:1].islower():
            flags[idx] = True
        if text:
            nxt = text
    return flags


def _join_lines(lines: list[dict]) -> tuple[str, list[tuple[int, int]], str, list[int], tuple[int, ...]]:
    """Join lines, dropping a soft line-wrap hyphen in the primary text.

    The primary string keeps today's exact-match behavior (``random-`` / ``ized``
    becomes ``randomized``). The preserved string keeps that hyphen so
    ``self-`` / ``reported`` still matches ``self-reported``. Preserved-to-primary
    indexes let a preserved hit report a bbox on the primary line spans.
    """
    texts = [collapse_ws(line.get("text")) for line in lines]
    flags = _soft_wrap_flags(texts)
    primary, preserved, origins, wraps, spans = [], [], [], [], []
    cursor = 0
    seen = False
    prev_soft = False
    for text, soft in zip(texts, flags):
        if not text:
            spans.append((cursor, cursor))
            continue
        if seen and not prev_soft:
            primary.append(" ")
            preserved.append(" ")
            origins.append(cursor)
            cursor += 1
        body = text[:-1] if soft else text
        start = cursor
        primary.append(body)
        preserved.append(text)
        for _ch in body:
            origins.append(cursor)
            cursor += 1
        if soft:
            wraps.append(len(origins))
            origins.append(cursor)
        spans.append((start, cursor))
        seen = True
        prev_soft = soft
    return "".join(primary), spans, "".join(preserved), origins, tuple(wraps)


def _index_fields(text: str, preserved: str, origins: list[int], wraps: tuple[int, ...]) -> dict:
    folded, fold_origins = _collapse_mapped(*_expand_mapped(text))
    same = preserved == text
    if same:
        pres_folded, pres_fold_origins = folded, fold_origins
    else:
        pres_folded, pres_fold_origins = _collapse_mapped(*_expand_mapped(preserved))
    return {
        "text": text,
        "foldedText": folded,
        "foldedOrigins": fold_origins,
        "preservedText": preserved,
        "preservedOrigins": origins,
        "preservedFoldedText": pres_folded,
        "preservedFoldedOrigins": pres_fold_origins,
        "preservedWraps": wraps,
        "preservedSame": same,
    }


def _preserved_line_texts(page) -> list[str]:
    """Re-read lines with ligatures and special spaces kept intact."""
    data = page.get_text("dict", flags=_LIGATURE_FLAGS) or {}
    texts = []
    for block in data.get("blocks") or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            raw = "".join(span.get("text") or "" for span in line.get("spans") or [])
            stripped = raw.strip()
            if stripped:
                texts.append(stripped)
    return texts


def _lines_compatible(extracted: str, preserved: str) -> bool:
    return fold_typographic(extracted) == fold_typographic(preserved)


def _restore_preserved_text(page, lines: list[dict]) -> None:
    """Put ligatures and special spaces back onto extractor lines when alignment holds."""
    preserved = _preserved_line_texts(page)
    if len(preserved) != len(lines):
        return
    for line, raw in zip(lines, preserved):
        if not _lines_compatible(str(line.get("text") or ""), raw):
            return
    for line, raw in zip(lines, preserved):
        line["text"] = raw


def _page_record(page, idx: int) -> dict:
    lines = _extract_page_lines(page, idx)
    _restore_preserved_text(page, lines)
    text, spans, preserved, origins, wraps = _join_lines(lines)
    return {"pageIndex": idx, "lines": lines, "spans": spans, **_index_fields(text, preserved, origins, wraps)}


def _page_records(pdf_bytes: bytes) -> list[dict]:
    records = []
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.needs_pass:
            _fail("invalid_pdf", "PDF is password protected and cannot be text-extracted.",
                  recovery_hint="Provide an unlocked PDF.")
        for idx in range(min(doc.page_count, MAX_SCAN_PAGES)):
            records.append(_page_record(doc[idx], idx))
    return records


def _scoped_pages(pages: list[dict], page_index: int | None) -> list[dict]:
    if page_index is not None and 0 <= page_index < len(pages):
        return [pages[page_index]]
    return pages


def _quote_hit(status: str, mode: str, page: dict, start: int, end: int) -> dict:
    return {"status": status, "matchMode": mode, "page": page, "span": (start, end)}


def _mapped_span(origins: list[int], pos: int, length: int) -> tuple[int, int] | None:
    last = pos + length - 1
    if pos < 0 or last >= len(origins):
        return None
    start, end = origins[pos], origins[last] + 1
    if end < start:
        return None
    return start, end


def _primary_from_preserved(page: dict, pos: int, length: int) -> tuple[int, int] | None:
    mapped = _mapped_span(page.get("preservedFoldedOrigins") or [], pos, length)
    if mapped is None:
        return None
    pres_start, pres_end = mapped
    origins = page.get("preservedOrigins") or []
    if pres_start >= len(origins):
        return None
    last = min(pres_end, len(origins)) - 1
    if last < pres_start:
        return None
    start = origins[pres_start]
    end = origins[last] if last in (page.get("preservedWraps") or ()) else origins[last] + 1
    if end < start:
        return None
    return start, end


def _locate_exact(pages: list[dict], needle: str) -> dict | None:
    low = needle.lower()
    for page in pages:
        pos = page["text"].find(needle)
        if pos >= 0:
            return _quote_hit("exact", "exact", page, pos, pos + len(needle))
    for page in pages:
        pos = page["text"].lower().find(low)
        if pos >= 0:
            return _quote_hit("normalized", "case_folded", page, pos, pos + len(low))
    return None


def _hit_folded(page: dict, needle: str, text_key: str, direct: bool) -> dict | None:
    pos = (page.get(text_key) or "").find(needle)
    if pos < 0:
        return None
    if direct:
        span = _mapped_span(page.get("foldedOrigins") or [], pos, len(needle))
    else:
        span = _primary_from_preserved(page, pos, len(needle))
    if not span:
        return None
    return _quote_hit("normalized", "typographic_folded", page, span[0], span[1])


def _locate_folded(pages: list[dict], quote: str) -> dict | None:
    folded = fold_typographic(quote)
    if not folded:
        return None
    for page in pages:
        hit = _hit_folded(page, folded, "foldedText", True)
        if hit:
            return hit
    for page in pages:
        if page.get("preservedSame"):
            continue
        hit = _hit_folded(page, folded, "preservedFoldedText", False)
        if hit:
            return hit
    return None


def _locate_quote(pages: list[dict], quote: str, page_index: int | None) -> dict | None:
    """Locate a quote inside its declared page (when given) or across all pages.

    Exact whitespace-collapsed text wins, then case folding, then typographic and
    line-wrap hyphen folding. Folded hits keep a span in the primary page text.
    """
    needle = collapse_ws(quote)
    scoped = _scoped_pages(pages, page_index)
    return _locate_exact(scoped, needle) or _locate_folded(scoped, needle)


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


def _parse_json_text(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _collect_json_leaks(value, prefix: str, found: list[str]) -> None:
    """Record forbidden RED keys and sealed ledger schemas inside a JSON value."""
    if isinstance(value, dict):
        schema = value.get("schema")
        if schema in _LEDGER_SCHEMAS:
            marker = f"schema={schema}"
            found.append(f"{prefix}.{marker}" if prefix else marker)
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if key in _FORBIDDEN_RED_KEYS:
                found.append(path)
            _collect_json_leaks(child, path, found)
        return
    if isinstance(value, list):
        for idx, item in enumerate(value):
            _collect_json_leaks(item, f"{prefix}[{idx}]", found)


def _entry_is_red_document(entry: dict) -> bool:
    if entry.get("schema") in _LEDGER_SCHEMAS:
        return True
    return any(key in _FORBIDDEN_RED_KEYS for key in entry)


def _entry_label(entry: dict) -> str:
    """Supplement filename, falling back to the basename of ``path``."""
    for key in ("name", "filename"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    path = entry.get("path")
    if isinstance(path, str) and path.strip():
        return Path(path).name
    return ""


def _json_bearing_name(name: str) -> bool:
    return Path(name).suffix.lower() in _JSON_SUPPLEMENT_EXTS


def _append_text_payload(payloads: list, name: str, text) -> None:
    if isinstance(text, (dict, list)):
        payloads.append(text)
        return
    if isinstance(text, str) and _json_bearing_name(name):
        parsed = _parse_json_text(text)
        if parsed is not None:
            payloads.append(parsed)


def _append_bytes_payload(payloads: list, name: str, raw) -> None:
    if not isinstance(raw, (bytes, bytearray)) or not _json_bearing_name(name):
        return
    parsed = _parse_json_text(bytes(raw).decode("utf-8-sig", errors="replace"))
    if parsed is not None:
        payloads.append(parsed)


def _append_path_payload(payloads: list, entry: dict) -> None:
    """Parse a path-only ``.json``/``.ipynb`` so metadata is leak-checked."""
    if payloads:
        return
    path = entry.get("path")
    if not isinstance(path, str) or not path.strip():
        return
    if entry.get("text") is not None or isinstance(entry.get("bytes"), (bytes, bytearray)):
        return
    name = _entry_label(entry)
    if not _json_bearing_name(name):
        return
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return
    _append_bytes_payload(payloads, name, raw)


def _supplement_payloads(entry: dict) -> list:
    name = _entry_label(entry)
    payloads: list = []
    _append_text_payload(payloads, name, entry.get("text"))
    _append_bytes_payload(payloads, name, entry.get("bytes"))
    _append_path_payload(payloads, entry)
    if _entry_is_red_document(entry):
        payloads.append(entry)
    return payloads


def _guard_supplement_leaks(entries: list[dict]) -> None:
    leaks: list[str] = []
    for entry in entries:
        label = _entry_label(entry) or "supplement"
        for payload in _supplement_payloads(entry):
            _collect_json_leaks(payload, label, leaks)
    if leaks:
        _fail(
            "forbidden_red_key",
            f"Supplement contains forbidden RED key(s): {', '.join(leaks[:5])}",
            exit_code=3,
            recovery_hint="Remove RED/gold ledger fields from supplements before BLUE validation.",
            extra={"leaks": leaks[:10]},
        )


def _row_alts(raw: str, ext: str) -> list[str]:
    """Space-joined CSV/TSV cells so a quote can use spaces or tabs instead of the delimiter."""
    if ext not in {".csv", ".tsv"}:
        return []
    delimiter = "\t" if ext == ".tsv" else ","
    try:
        cells = next(csv.reader([raw], delimiter=delimiter))
    except (csv.Error, StopIteration):
        return []
    joined = collapse_ws(" ".join(cells))
    if not joined or joined == collapse_ws(raw):
        return []
    return [joined]


def _lines_for_text(text: str, name: str, ext: str) -> list[dict]:
    rows = text.splitlines() or ([text] if text else [])
    return [
        {
            "text": row,
            "lineNumber": number,
            "supplementName": name,
            "bbox": None,
            "pageIndex": None,
            "alts": _row_alts(row, ext),
        }
        for number, row in enumerate(rows, start=1)
    ]


def _append_search_alts(text: str, preserved: str, origins: list[int], lines: list[dict]):
    """Append delimiter-insensitive CSV/TSV alternates onto both search strings."""
    pieces, extra, cursor = [], [], len(text)
    for idx, line in enumerate(lines):
        for alt in line.get("alts") or []:
            collapsed = collapse_ws(alt)
            if not collapsed or collapsed == collapse_ws(line.get("text")):
                continue
            piece = " " + collapsed
            start = cursor + 1
            cursor += len(piece)
            pieces.append(piece)
            extra.append((start, cursor, idx))
    suffix = "".join(pieces)
    base = len(text)
    return text + suffix, preserved + suffix, origins + [base + offset for offset in range(len(suffix))], extra


def _search_blob(lines: list[dict]):
    text, spans, preserved, origins, wraps = _join_lines(lines)
    text, preserved, origins, extra = _append_search_alts(text, preserved, origins, lines)
    return text, spans, extra, preserved, origins, wraps


def _docx_text(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile):
        return raw.decode("utf-8-sig", errors="replace")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return raw.decode("utf-8-sig", errors="replace")
    texts = [elem.text for elem in root.iter() if elem.tag.endswith("}t") and elem.text]
    return "\n".join(texts)


def _pdf_page_texts(raw: bytes) -> list[tuple[int, str]]:
    try:
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            limit = min(doc.page_count, MAX_SCAN_PAGES)
            return [(idx, doc[idx].get_text("text") or "") for idx in range(limit)]
    except Exception as exc:
        _fail("invalid_pdf", f"Supplement PDF could not be read: {exc}", exit_code=2,
              recovery_hint="Provide a readable supplement PDF or pre-extracted page text.")


def _page_pairs(pages: list) -> list[tuple[int | None, str]]:
    pairs = []
    for idx, item in enumerate(pages):
        if isinstance(item, str):
            pairs.append((idx, item))
        elif isinstance(item, dict) and isinstance(item.get("text"), str):
            page_index = item.get("pageIndex")
            pairs.append((page_index if isinstance(page_index, int) else idx, item["text"]))
    return pairs


def _reject_oversized_entry(size: int) -> None:
    if size > _MAX_SUPPLEMENT_ENTRY_BYTES:
        _fail(
            "invalid_arguments",
            "Supplement entry exceeds 25 MiB.",
            exit_code=2,
            recovery_hint="Split the workbook or notebook before BLUE quote checks.",
        )


def _reject_xml_payload(payload: bytes) -> None:
    """Reject DTD declarations before the stdlib XML parser sees the bytes."""
    _reject_oversized_entry(len(payload))
    lowered = payload.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        _fail(
            "invalid_arguments",
            "Supplement XML rejects DOCTYPE and ENTITY declarations.",
            exit_code=2,
            recovery_hint="Remove DTD declarations from the workbook XML.",
        )


def _zip_xml(archive: zipfile.ZipFile, name: str) -> bytes | None:
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    _reject_oversized_entry(info.file_size)
    with archive.open(info) as handle:
        payload = handle.read(_MAX_SUPPLEMENT_ENTRY_BYTES + 1)
    _reject_oversized_entry(len(payload))
    _reject_xml_payload(payload)
    return payload


def _xml_root(payload: bytes):
    try:
        return ET.fromstring(payload)
    except ET.ParseError:
        return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _first_child(node, name: str):
    for child in list(node):
        if _local_name(child.tag) == name:
            return child
    return None


def _attr_local(node, suffix: str) -> str:
    wanted = "}" + suffix
    for key, value in node.attrib.items():
        if key == suffix or key.endswith(wanted):
            return str(value)
    return ""


def _direct_text(node, tag: str) -> str:
    child = _first_child(node, tag)
    if child is None or not child.text:
        return ""
    return child.text


def _join_sheet_path(target: str) -> str:
    parts: list[str] = []
    cleaned = target.replace("\\", "/").split("?", 1)[0]
    for part in cleaned.split("/"):
        if part in ("", "."):
            continue
        if part == ".." and parts:
            parts.pop()
            continue
        if part != "..":
            parts.append(part)
    if parts and parts[0].lower() == "xl":
        return "/".join(parts)
    return "xl/" + "/".join(parts)


def _sheet_rels(archive: zipfile.ZipFile) -> dict[str, str]:
    payload = _zip_xml(archive, "xl/_rels/workbook.xml.rels")
    if payload is None:
        return {}
    root = _xml_root(payload)
    if root is None:
        return {}
    rels: dict[str, str] = {}
    for node in root.iter():
        if _local_name(node.tag) != "Relationship":
            continue
        kind = node.attrib.get("Type") or ""
        ident = node.attrib.get("Id") or ""
        target = node.attrib.get("Target") or ""
        if ident and target and "worksheet" in kind:
            rels[ident] = target
    return rels


def _fallback_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    names = [
        info.filename for info in archive.infolist()
        if info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml")
        and not info.filename.endswith("/")
    ]
    return [(Path(name).stem, name) for name in sorted(names)]


def _workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    rels = _sheet_rels(archive)
    payload = _zip_xml(archive, "xl/workbook.xml")
    if payload is None:
        return _fallback_sheets(archive)
    root = _xml_root(payload)
    if root is None:
        return _fallback_sheets(archive)
    sheets: list[tuple[str, str]] = []
    for node in root.iter():
        if _local_name(node.tag) != "sheet":
            continue
        target = rels.get(_attr_local(node, "id")) or ""
        if not target:
            continue
        sheets.append((str(node.attrib.get("name") or "Sheet"), _join_sheet_path(target)))
    if sheets:
        return sheets
    return _fallback_sheets(archive)


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    payload = _zip_xml(archive, "xl/sharedStrings.xml")
    if payload is None:
        return []
    root = _xml_root(payload)
    if root is None:
        return []
    strings: list[str] = []
    for node in root.iter():
        if _local_name(node.tag) != "si":
            continue
        parts = [elem.text or "" for elem in node.iter() if _local_name(elem.tag) == "t" and elem.text]
        strings.append("".join(parts))
    return strings


def _column_index(ref: str) -> int:
    number = 0
    for char in ref:
        if not char.isalpha():
            break
        number = number * 26 + (ord(char.upper()) - 64)
    return number


def _row_number(ref: str, fallback: int) -> int:
    digits = "".join(char for char in ref if char.isdigit())
    if digits.isdigit():
        return int(digits)
    return fallback


def _shared_at(strings: list[str], value: str) -> str:
    if value.isdigit() and int(value) < len(strings):
        return strings[int(value)]
    return value


def _inline_text(cell) -> str:
    inline = _first_child(cell, "is")
    node = inline if inline is not None else cell
    parts = [elem.text for elem in node.iter() if _local_name(elem.tag) == "t" and elem.text]
    return "".join(parts)


def _shown_cell_value(cell, kind: str, strings: list[str]) -> str:
    if kind == "inlineStr":
        return _inline_text(cell)
    value = _direct_text(cell, "v")
    if kind == "s":
        return _shared_at(strings, value)
    return value


def _formula_text(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    if text.startswith("="):
        return text
    return "=" + text


def _cell_display(cell, strings: list[str]) -> str:
    """Show static formula text and the cached value together in one cell."""
    kind = cell.attrib.get("t") or ""
    formula = _formula_text(_direct_text(cell, "f"))
    shown = _shown_cell_value(cell, kind, strings)
    if formula and shown:
        return f"{formula} {shown}"
    return formula or shown


def _row_line(cells: list[tuple[int, str]]) -> str:
    ordered = [text for _index, text in sorted(cells) if text]
    return "\t".join(ordered)


def _sheet_rows(root, strings: list[str]) -> list[str]:
    grouped: dict[int, list[tuple[int, str]]] = {}
    order: list[int] = []
    for cell in root.iter():
        if _local_name(cell.tag) != "c":
            continue
        text = _cell_display(cell, strings)
        if not text:
            continue
        ref = cell.attrib.get("r") or ""
        row_num = _row_number(ref, len(order) + 1)
        if row_num not in grouped:
            grouped[row_num] = []
            order.append(row_num)
        grouped[row_num].append((_column_index(ref), text))
    return [_row_line(grouped[num]) for num in order]


def _sheet_lines(archive: zipfile.ZipFile, name: str, path: str, strings: list[str]) -> list[str]:
    lines = [f"[Sheet: {name}]"]
    payload = _zip_xml(archive, path)
    if payload is None:
        return lines
    root = _xml_root(payload)
    if root is None:
        return lines
    lines.extend(line for line in _sheet_rows(root, strings) if line)
    return lines


def _xlsx_archive_text(archive: zipfile.ZipFile) -> str:
    strings = _shared_strings(archive)
    lines: list[str] = []
    for name, path in _workbook_sheets(archive):
        lines.extend(_sheet_lines(archive, name, path, strings))
    return "\n".join(lines)


def _xlsx_text(raw: bytes) -> str:
    _reject_oversized_entry(len(raw))
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            return _xlsx_archive_text(archive)
    except zipfile.BadZipFile:
        return ""


def _pack_lines(chunks: list[str]) -> str:
    lines: list[str] = []
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.strip():
                lines.append(line)
    return "\n".join(lines)


def _join_source(value) -> str:
    if isinstance(value, list):
        return "".join(str(part) for part in value)
    if isinstance(value, str):
        return value
    return ""


def _error_plain(output: dict) -> str:
    parts: list[str] = []
    for key in ("ename", "evalue"):
        value = output.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value)
    trace = output.get("traceback")
    if isinstance(trace, list):
        parts.extend(str(item) for item in trace if str(item).strip())
    return "\n".join(parts)


def _output_plain(output: dict) -> str:
    kind = str(output.get("output_type") or "")
    if kind == "stream":
        return _join_source(output.get("text"))
    if kind in {"execute_result", "display_data"}:
        data = output.get("data")
        if isinstance(data, dict):
            return _join_source(data.get("text/plain"))
        return ""
    if kind == "error":
        return _error_plain(output)
    return ""


def _notebook_chunks(data: dict) -> list[str]:
    cells = data.get("cells")
    if not isinstance(cells, list):
        return []
    chunks: list[str] = []
    for cell in cells:
        if not isinstance(cell, dict) or cell.get("cell_type") not in {"markdown", "code"}:
            continue
        chunks.append(_join_source(cell.get("source")))
        if cell.get("cell_type") != "code":
            continue
        for output in cell.get("outputs") or []:
            if isinstance(output, dict):
                chunks.append(_output_plain(output))
    return chunks


def _ipynb_text(text: str) -> str:
    parsed = _parse_json_text(text)
    if isinstance(parsed, dict):
        return _pack_lines(_notebook_chunks(parsed))
    return text


def _render_notebook(value) -> str:
    if isinstance(value, str):
        return _ipynb_text(value)
    if isinstance(value, dict):
        return _pack_lines(_notebook_chunks(value))
    return ""


def _is_notebook(name: str, value) -> bool:
    if Path(name).suffix.lower() == ".ipynb":
        return True
    return isinstance(value, dict) and isinstance(value.get("cells"), list)


def _texts_from_structured(name: str, value) -> list[tuple[int | None, str]]:
    if _is_notebook(name, value):
        return [(None, _render_notebook(value))]
    return [(None, json.dumps(value, ensure_ascii=False))]


def _texts_from_text(name: str, text: str) -> list[tuple[int | None, str]]:
    if Path(name).suffix.lower() == ".ipynb":
        return [(None, _ipynb_text(text))]
    return [(None, text)]


def _texts_from_bytes(raw: bytes, name: str) -> list[tuple[int | None, str]]:
    ext = Path(name).suffix.lower()
    if raw.startswith(b"%PDF-"):
        return _pdf_page_texts(raw)
    if ext == ".xlsx":
        return [(None, _xlsx_text(raw))]
    if ext == ".ipynb":
        return [(None, _ipynb_text(raw.decode("utf-8-sig", errors="replace")))]
    if ext in _PLAIN_TEXT_EXTS:
        return [(None, raw.decode("utf-8-sig", errors="replace"))]
    if ext == ".docx" or raw[:2] == b"PK":
        return [(None, _docx_text(raw))]
    return [(None, raw.decode("utf-8-sig", errors="replace"))]


def _load_entry_bytes(entry: dict) -> tuple[bytes, str] | None:
    name = _entry_label(entry)
    raw = entry.get("bytes")
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw), name
    path = entry.get("path")
    if not isinstance(path, str) or not path.strip():
        return None
    if entry.get("text") is not None or isinstance(entry.get("pages"), list):
        return None
    try:
        return Path(path).read_bytes(), name or Path(path).name
    except OSError as exc:
        _fail(
            "invalid_arguments",
            f"Supplement path could not be read: {exc}",
            exit_code=2,
            recovery_hint="Pass a readable supplement path, bytes, or text.",
        )


def _texts_from_declared(entry: dict) -> list[tuple[int | None, str]]:
    name = _entry_label(entry)
    text = entry.get("text")
    pages = entry.get("pages")
    if isinstance(pages, list) and Path(name).suffix.lower() not in {".xlsx", ".ipynb"}:
        return _page_pairs(pages)
    if isinstance(text, str):
        return _texts_from_text(name, text)
    if isinstance(text, (dict, list)):
        return _texts_from_structured(name, text)
    return [(None, "")]


def _texts_for_entry(entry: dict) -> list[tuple[int | None, str]]:
    loaded = _load_entry_bytes(entry)
    if loaded is not None:
        return _texts_from_bytes(loaded[0], loaded[1])
    return _texts_from_declared(entry)


def _records_for_entry(entry: dict, idx: int) -> list[dict]:
    name = _entry_label(entry) or f"supplement-{idx + 1}"
    ext = Path(name).suffix.lower()
    records = []
    for page_index, text in _texts_for_entry(entry):
        lines = _lines_for_text(text, name, ext)
        blob, spans, extra, preserved, origins, wraps = _search_blob(lines)
        records.append({
            "supplementName": name,
            "pageIndex": page_index,
            "lines": lines,
            "spans": spans,
            "extraSpans": extra,
            **_index_fields(blob, preserved, origins, wraps),
        })
    return records


def _prepare_supplements(supplements) -> list[dict]:
    if not supplements:
        return []
    if not isinstance(supplements, list):
        _fail("invalid_arguments", "supplements must be a list of supplement objects.",
              exit_code=2, recovery_hint="Pass supplements=[{'name', 'text'|'pages'|'bytes'}, ...].")
    entries = []
    for idx, entry in enumerate(supplements):
        if not isinstance(entry, dict):
            _fail("invalid_arguments", f"Supplement #{idx + 1} must be an object.", exit_code=2,
                  recovery_hint="Each supplement needs name plus text, pages, or bytes.")
        entries.append(entry)
    _guard_supplement_leaks(entries)
    records: list[dict] = []
    for idx, entry in enumerate(entries):
        records.extend(_records_for_entry(entry, idx))
    return records


def _line_for_span(page: dict, span: tuple[int, int]) -> dict | None:
    start = span[0]
    for line, (lo, hi) in zip(page.get("lines") or [], page.get("spans") or []):
        if lo <= start < hi or (hi == lo and start == lo):
            return line
    for lo, hi, idx in page.get("extraSpans") or []:
        if lo <= start < hi and 0 <= idx < len(page.get("lines") or []):
            return page["lines"][idx]
    lines = page.get("lines") or []
    return lines[-1] if lines else None


def _name_matches(wanted: str, record: dict) -> bool:
    target = Path(str(wanted or "")).name.lower()
    current = Path(str(record.get("supplementName") or "")).name.lower()
    return bool(target) and target == current


def _explicit_supplement_name(finding: dict) -> str:
    value = finding.get("supplementName")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ""


def _label_mentions(label: str, name: str) -> bool:
    lowered = label.lower()
    current = name.lower()
    stem = Path(name).name.lower()
    if current and current in lowered:
        return True
    return bool(stem) and stem in lowered


def _preferred_supplement_name(finding: dict, records: list[dict]) -> str:
    """Filename hint used only to order supplement search after the PDF miss."""
    file_name = finding.get("supplementFile")
    if isinstance(file_name, str) and file_name.strip():
        return file_name.strip()
    label = collapse_ws(finding.get("locationLabel"))
    if not label:
        return ""
    for record in records:
        name = str(record.get("supplementName") or "")
        if _label_mentions(label, name):
            return name
    if "supp-" not in label.lower():
        return ""
    for record in records:
        if "supp-" in str(record.get("supplementName") or "").lower():
            return str(record["supplementName"])
    return ""


def _order_records(records: list[dict], preferred: str) -> list[dict]:
    if not preferred:
        return list(records)
    first = [rec for rec in records if _name_matches(preferred, rec)]
    rest = [rec for rec in records if not _name_matches(preferred, rec)]
    return first + rest


def _locate_in_records(records: list[dict], quote: str) -> dict | None:
    located = _locate_quote(records, quote, None)
    if not located:
        return None
    page = located["page"]
    line = _line_for_span(page, located["span"])
    return {
        "kind": "supplement",
        "status": located["status"],
        "matchMode": located.get("matchMode"),
        "pageIndex": page.get("pageIndex"),
        "supplementName": page.get("supplementName"),
        "lineNumber": (line or {}).get("lineNumber") or 1,
    }


def _wrap_pdf(located: dict | None) -> dict | None:
    if not located:
        return None
    return {
        "kind": "pdf",
        "status": located["status"],
        "matchMode": located.get("matchMode"),
        "page": located["page"],
        "span": located["span"],
    }


def _locate_named_first(name: str, quote: str, pages: list[dict], page_index: int | None,
                        records: list[dict]) -> dict | None:
    preferred = [rec for rec in records if _name_matches(name, rec)]
    others = [rec for rec in records if not _name_matches(name, rec)]
    hit = _locate_in_records(preferred, quote)
    if hit:
        return hit
    pdf_hit = _wrap_pdf(_locate_quote(pages, quote, page_index))
    if pdf_hit:
        return pdf_hit
    return _locate_in_records(others, quote)


def _locate_finding_quote(finding: dict, quote: str, pages: list[dict],
                          supplement_records) -> dict | None:
    records = supplement_records or []
    page_index = declared_page_index(finding)
    named = _explicit_supplement_name(finding)
    if named and records:
        return _locate_named_first(named, quote, pages, page_index, records)
    pdf_hit = _wrap_pdf(_locate_quote(pages, quote, page_index))
    if pdf_hit:
        return pdf_hit
    if not records:
        return None
    preferred = _preferred_supplement_name(finding, records)
    return _locate_in_records(_order_records(records, preferred), quote)


def _found_quote_record(finding: dict, index: int, quote: str, located: dict) -> dict:
    base = {
        "findingId": finding_id(finding, index),
        "quote": quote,
        "status": located["status"],
        "matchMode": located.get("matchMode"),
        "nearestCandidates": [],
    }
    if located["kind"] == "supplement":
        return {
            **base,
            "pageIndex": located.get("pageIndex"),
            "bbox": None,
            "source": "supplement",
            "supplementName": located.get("supplementName"),
            "lineNumber": located.get("lineNumber"),
        }
    return {
        **base,
        "pageIndex": located["page"]["pageIndex"],
        "bbox": _span_bbox(located["page"], located["span"]),
    }


def _format_candidate(line: dict) -> dict:
    if line.get("supplementName"):
        return {
            "text": line.get("text") or "",
            "pageIndex": None,
            "bbox": None,
            "supplementName": line["supplementName"],
            "lineNumber": line.get("lineNumber"),
        }
    return {
        "pageIndex": line.get("pageIndex"),
        "bbox": line.get("bbox"),
        "text": line.get("text") or "",
    }


def _ranked_candidates(lines: list[dict], quote: str, limit: int) -> list[dict]:
    needle = collapse_ws(quote)
    ranked = sorted(
        lines,
        key=lambda line: _line_similarity(needle, line.get("text") or ""),
        reverse=True,
    )
    return [_format_candidate(line) for line in ranked[:limit]]


def _missing_candidates(pages, records, quote, page_index, limit) -> list[dict]:
    if records is None:
        return _nearest_candidates(pages, quote, page_index, limit)
    lines = [line for page in _scoped_pages(pages, page_index) for line in page["lines"]]
    for record in records:
        lines.extend(record.get("lines") or [])
    return _ranked_candidates(lines, quote, limit)


def _missing_quote_record(finding, index, quote, pages, records, max_candidates) -> dict:
    return {
        "findingId": finding_id(finding, index),
        "quote": quote,
        "status": "missing",
        "pageIndex": None,
        "bbox": None,
        "nearestCandidates": _missing_candidates(
            pages, records, quote, declared_page_index(finding), max_candidates,
        ),
        "recoveryHint": (
            "Quote not found in the PDF text. Re-read the cited page, paste the verbatim "
            "string, or abstain with verdictLabel 확인필요."
        ),
    }


def check_finding_quote(finding: dict, index: int, pages: list[dict],
                        max_candidates: int, supplement_records=None) -> dict | None:
    """Verify one finding quote exists verbatim; None when the finding carries no quote."""
    quote = finding_quote(finding)
    if len(collapse_ws(quote)) < MIN_QUOTE_CHARS:
        return None
    located = _locate_finding_quote(finding, quote, pages, supplement_records)
    if located:
        return _found_quote_record(finding, index, quote, located)
    return _missing_quote_record(finding, index, quote, pages, supplement_records, max_candidates)


def _quote_check(findings: list[dict], pages: list[dict], max_candidates: int,
                 supplement_records=None) -> dict:
    quotes, unquoted = [], 0
    for idx, finding in enumerate(findings):
        record = check_finding_quote(finding, idx, pages, max_candidates, supplement_records)
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


def _require_repair_flag(include_repair_pack) -> None:
    if type(include_repair_pack) is not bool:
        _fail("invalid_arguments", "include_repair_pack must be a boolean.")


def _pack_bytes(pack: dict) -> int:
    return len(json.dumps(pack, ensure_ascii=False).encode("utf-8"))


def _quote_rows(result) -> list[dict]:
    if not isinstance(result, dict):
        return []
    check = result.get("quoteCheck")
    if not isinstance(check, dict):
        return []
    quotes = check.get("quotes")
    if not isinstance(quotes, list):
        return []
    return [row for row in quotes if isinstance(row, dict) and row.get("status") == "missing"]


def _recovered_ids(result) -> list[str]:
    if not isinstance(result, dict):
        return []
    zero = result.get("zeroDrop")
    if not isinstance(zero, dict):
        return []
    ids = zero.get("recoveredFindingIds")
    if not isinstance(ids, list):
        return []
    return [str(item) for item in ids if item is not None]


def _safe_findings(report) -> list[dict]:
    try:
        rows = report_findings(report)
    except BlueReportError:
        return []
    return [item for item in rows if isinstance(item, dict)]


def _safe_ledger(report) -> list[dict]:
    if not isinstance(report, dict):
        return []
    try:
        rows = ledger_entries(report.get("candidateLedger"))
    except BlueReportError:
        return []
    return [item for item in rows if isinstance(item, dict)]


def _remember_finding(index: dict, ident, finding: dict) -> None:
    if ident and ident not in index and isinstance(finding, dict):
        index[ident] = finding


def _repair_finding_index(report) -> dict:
    index: dict = {}
    for idx, finding in enumerate(_safe_findings(report)):
        _remember_finding(index, finding_id(finding, idx), finding)
    for idx, entry in enumerate(_safe_ledger(report)):
        ident = entry.get("candidateId") or entry.get("id") or f"ZD-{idx + 1}"
        _remember_finding(index, str(ident), entry)
    return index


def _candidate_shape(raw: dict) -> dict:
    return {
        "pageIndex": raw.get("pageIndex"),
        "bbox": raw.get("bbox"),
        "supplementName": raw.get("supplementName"),
        "lineNumber": raw.get("lineNumber"),
        "text": raw.get("text") or "",
    }


def _limit_candidates(raw, limit: int) -> list[dict]:
    if not isinstance(raw, list):
        return []
    shaped = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        shaped.append(_candidate_shape(item))
        if len(shaped) >= limit:
            break
    return shaped


def _repair_lines(pdf_bytes, supplements) -> list[dict]:
    lines: list[dict] = []
    if isinstance(pdf_bytes, (bytes, bytearray)) and bytes(pdf_bytes).startswith(b"%PDF-"):
        for page in _page_records(bytes(pdf_bytes)):
            lines.extend(page["lines"])
    if supplements:
        for record in _prepare_supplements(supplements):
            lines.extend(record.get("lines") or [])
    return lines


def _same_line(line: dict, top: dict) -> bool:
    if (line.get("text") or "") != (top.get("text") or ""):
        return False
    if top.get("supplementName"):
        return (
            line.get("supplementName") == top.get("supplementName")
            and line.get("lineNumber") == top.get("lineNumber")
        )
    return line.get("pageIndex") == top.get("pageIndex")


def _find_line_index(lines: list[dict], top: dict) -> int | None:
    for idx, line in enumerate(lines):
        if _same_line(line, top):
            return idx
    return None


def _context_for(lines: list[dict], top: dict | None) -> list[dict]:
    if not top or not lines:
        return []
    idx = _find_line_index(lines, top)
    if idx is None:
        return [_candidate_shape(top)]
    start = max(0, idx - 1)
    return [_candidate_shape(line) for line in lines[start:idx + 2]]


def _verdict_of(finding) -> str:
    if not isinstance(finding, dict):
        return "확인필요"
    verdict = finding.get("verdictLabel")
    if isinstance(verdict, str) and verdict.strip():
        return verdict
    return "확인필요"


def _repair_item(row: dict, findings: dict, lines: list[dict], limit: int) -> dict:
    ident = str(row.get("findingId") or "")
    finding = findings.get(ident) or {}
    candidates = _limit_candidates(row.get("nearestCandidates"), limit)
    top = candidates[0] if candidates else None
    return {
        "findingId": ident,
        "declaredPageIndex": declared_page_index(finding) if finding else None,
        "verdictLabel": _verdict_of(finding),
        "rejectedQuote": row.get("quote") or "",
        "nearestCandidates": candidates,
        "contextWindow": _context_for(lines, top),
        "allowedActions": list(_REPAIR_ACTIONS),
    }


def _repair_items(result, report, pdf_bytes, supplements, limit: int) -> list[dict]:
    findings = _repair_finding_index(report)
    lines = _repair_lines(pdf_bytes, supplements)
    return [_repair_item(row, findings, lines, limit) for row in _quote_rows(result)]


def _shrink_prompt(pack: dict, max_bytes: int) -> None:
    snippet = pack.get("promptSnippet") or ""
    while snippet and _pack_bytes(pack) > max_bytes:
        snippet = snippet[: max(0, len(snippet) // 2)]
        pack["promptSnippet"] = snippet
    if _pack_bytes(pack) > max_bytes:
        pack["promptSnippet"] = ""


def _clear_context(pack: dict, max_bytes: int) -> None:
    for item in reversed(pack["items"]):
        if _pack_bytes(pack) <= max_bytes:
            return
        item["contextWindow"] = []


def _drop_items(pack: dict, max_bytes: int) -> None:
    items = pack["items"]
    while items and _pack_bytes(pack) > max_bytes:
        items.pop()
    if _pack_bytes(pack) <= max_bytes:
        return
    pack["promptSnippet"] = ""
    pack["recoveredFindingIds"] = []
    while items and _pack_bytes(pack) > max_bytes:
        items.pop()


def _fit_pack(pack: dict, max_bytes: int) -> dict:
    if _pack_bytes(pack) <= max_bytes:
        pack["truncated"] = False
        return pack
    pack["truncated"] = True
    _shrink_prompt(pack, max_bytes)
    if _pack_bytes(pack) <= max_bytes:
        return pack
    _clear_context(pack, max_bytes)
    if _pack_bytes(pack) <= max_bytes:
        return pack
    _drop_items(pack, max_bytes)
    return pack


def _reject_pack_leaks(pack: dict) -> dict:
    leaks = forbidden_keys(pack)
    if leaks:
        _fail(
            "forbidden_red_key",
            f"Repair pack contains forbidden RED key(s): {', '.join(leaks[:5])}",
            exit_code=3,
            recovery_hint="Remove RED/gold ledger fields before building a BLUE repair pack.",
            extra={"leaks": leaks[:10]},
        )
    return pack


def build_blue_repair_pack(validation_result: dict, report, *, pdf_bytes: bytes | None = None,
                           supplements=None, max_candidates: int = 3,
                           max_bytes: int = MAX_REPAIR_PACK_BYTES) -> dict:
    """Build a bounded one-turn repair packet for missing BLUE quotes."""
    pack = {
        "schema": REPAIR_PACK_SCHEMA,
        "truncated": False,
        "recoveredFindingIds": _recovered_ids(validation_result),
        "items": _repair_items(validation_result, report, pdf_bytes, supplements, max_candidates),
        "promptSnippet": _REPAIR_PROMPT,
    }
    return _reject_pack_leaks(_fit_pack(pack, max_bytes))


def validate_blue_report(pdf_bytes, report, *, ledger=None, supplements=None, csv_path=None,
                         max_candidates: int = 5, paper_id: str | None = None,
                         file_hash: str | None = None, include_repair_pack: bool = False) -> dict:
    """Validate a BLUE report against a PDF and optional supplements."""
    _require_repair_flag(include_repair_pack)
    raw = _require_pdf_bytes(pdf_bytes)
    _require_max_candidates(max_candidates)
    findings = report_findings(report)
    validate_findings(findings)
    entries = _resolve_ledger_entries(ledger, report)
    _guard_red_leaks(report, entries)
    supplement_records = None if supplements is None else _prepare_supplements(supplements)
    reconciled = reconcile_candidate_ledger(entries, findings)
    checks = _quote_check(
        reconciled["findings"] + reconciled["resolvedOk"], _page_records(raw), max_candidates,
        supplement_records,
    )
    digest = file_hash or hashlib.sha256(raw).hexdigest()
    paper_identifier = paper_id or _report_paper_id(report, f"paper-{digest[:12]}")
    warnings = _ledger_override_warning(ledger, report)
    csv_result = None
    if csv_path is not None:
        csv_result = _emit_csv(
            csv_path, reconciled, paper_identifier, _csv_defaults(report), warnings
        )
    result = {
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
    if include_repair_pack:
        result["repairPack"] = build_blue_repair_pack(
            result, report, pdf_bytes=raw, supplements=supplements,
        )
    return result


# --------------------------------------------------------------- finalize


def _path_key(path) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def _paths_collide(left, right) -> bool:
    if left in (None, "") or right in (None, ""):
        return False
    return _path_key(left) == _path_key(right)


def _guard_output_collision(out_report_path, csv_path, input_paths) -> None:
    """Refuse outputs that resolve onto each other or onto an input path."""
    if _paths_collide(out_report_path, csv_path):
        _fail(
            "cannot_overwrite_input",
            "out_report_path and csv_path resolve to the same file.",
            exit_code=2,
            recovery_hint="Write the finalized report and the CSV to different paths.",
        )
    for output in (out_report_path, csv_path):
        if not output:
            continue
        for src in input_paths or ():
            if src and _paths_collide(output, src):
                _fail(
                    "cannot_overwrite_input",
                    f"Output path cannot match an input path: {output}",
                    exit_code=2,
                    recovery_hint="Write JSON/CSV outputs to paths distinct from the inputs.",
                )


def _guard_finalize_leaks(report, ledger, repairs, supplements) -> None:
    leaks: list[str] = []
    labeled = (
        ("report", report),
        ("ledger", ledger),
        ("repairs", repairs),
        ("supplements", supplements),
    )
    for label, value in labeled:
        for path in forbidden_keys(value):
            leaks.append(f"{label}.{path}")
    if leaks:
        _fail(
            "forbidden_red_key",
            f"BLUE finalize input contains forbidden RED key(s): {', '.join(leaks[:5])}",
            exit_code=3,
            recovery_hint="Remove RED/gold ledger fields before finalizing a BLUE report.",
            extra={"leaks": leaks[:10]},
        )


def _repair_id(item: dict) -> str:
    for key in ("findingId", "candidateId", "id"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _normalize_repair(item) -> tuple[str, dict] | None:
    if not isinstance(item, dict):
        return None
    ident = _repair_id(item)
    if not ident:
        return None
    return ident, item


def _pairs_from_list(items: list) -> list[tuple[str, dict]]:
    pairs = []
    for item in items:
        pair = _normalize_repair(item)
        if pair is not None:
            pairs.append(pair)
    return pairs


def _repair_pairs_from_dict(repairs: dict) -> list[tuple[str, dict]]:
    nested = repairs.get("repairs")
    if isinstance(nested, list):
        return _pairs_from_list(nested)
    if _repair_id(repairs):
        pair = _normalize_repair(repairs)
        return [pair] if pair else []
    pairs: list[tuple[str, dict]] = []
    for key, value in repairs.items():
        if isinstance(value, str):
            pairs.append((str(key), {"quote": value}))
        elif isinstance(value, dict):
            pairs.append((str(key), value))
    return pairs


def _repair_pairs(repairs) -> list[tuple[str, dict]]:
    if repairs is None:
        return []
    if isinstance(repairs, list):
        return _pairs_from_list(repairs)
    if isinstance(repairs, dict):
        return _repair_pairs_from_dict(repairs)
    _fail(
        "invalid_arguments",
        "repairs must be a list, a findingId mapping, or {'repairs': [...]}.",
        exit_code=2,
        recovery_hint="Pass repairs as a list of {findingId, quote, verdictLabel} objects.",
    )


def _target_matches(repair_id: str, target: dict, index: int) -> bool:
    if not repair_id:
        return False
    if repair_id == finding_id(target, index):
        return True
    for key in ("candidateId", "id", "findingId", "reportNumber"):
        value = target.get(key)
        if isinstance(value, str) and value.strip() == repair_id:
            return True
    return False


def _apply_quote_repair(target: dict, repair: dict) -> bool:
    quote = repair.get("quote")
    if not isinstance(quote, str):
        return False
    target["quote"] = quote
    target["excerpt"] = ""
    return True


def _apply_verdict_repair(target: dict, repair: dict) -> bool:
    action = str(repair.get("action") or "")
    raw = repair.get("verdictLabel", repair.get("verdict"))
    if action == "downgrade_verdictLabel_to_확인필요":
        raw = "확인필요"
    label = normalize_verdict_label(raw) if isinstance(raw, str) else ""
    if label != "확인필요":
        return False
    target["verdictLabel"] = "확인필요"
    if "verdict" in target:
        target["verdict"] = "needs_check"
    return True


def _apply_repair_to_target(target: dict, repair: dict) -> bool:
    quoted = _apply_quote_repair(target, repair)
    verdict = _apply_verdict_repair(target, repair)
    return quoted or verdict


def _apply_repairs_to(targets: list, pairs: list[tuple[str, dict]]) -> int:
    applied = 0
    for index, target in enumerate(targets):
        if not isinstance(target, dict):
            continue
        for ident, repair in pairs:
            if _target_matches(ident, target, index) and _apply_repair_to_target(target, repair):
                applied += 1
    return applied


def _apply_all_repairs(findings: list, entries: list, repairs) -> int:
    pairs = _repair_pairs(repairs)
    return _apply_repairs_to(findings, pairs) + _apply_repairs_to(entries, pairs)


def _copied_report_findings(report) -> list[dict]:
    rows = report_findings(report)
    validate_findings(rows)
    return [dict(item) for item in rows]


def _copied_ledger_entries(ledger, report) -> list:
    copied = []
    for item in _resolve_ledger_entries(ledger, report):
        copied.append(dict(item) if isinstance(item, dict) else item)
    return copied


def _clear_quote_fields(finding: dict) -> str:
    original = finding_quote(finding)
    for key in QUOTE_FIELDS:
        finding[key] = ""
    return original


def _prefix_rationale(finding: dict) -> None:
    rationale = finding.get("rationale")
    text = rationale if isinstance(rationale, str) else ""
    if text.startswith(AUTO_DOWNGRADE_PREFIX):
        finding["rationale"] = text
        return
    finding["rationale"] = AUTO_DOWNGRADE_PREFIX + text


def _downgrade_unverified(finding: dict) -> dict:
    updated = dict(finding)
    updated["unverifiedQuote"] = _clear_quote_fields(updated)
    updated["autoDowngraded"] = True
    updated["verdictLabel"] = "확인필요"
    if "verdict" in finding:
        updated["verdict"] = "needs_check"
    _prefix_rationale(updated)
    return updated


def _classify_rows(rows, pages, records, max_candidates: int, start: int = 0):
    kept, dropped, ids = [], [], []
    for offset, finding in enumerate(rows):
        if not isinstance(finding, dict):
            continue
        index = start + offset
        record = check_finding_quote(finding, index, pages, max_candidates, records)
        if isinstance(record, dict) and record.get("status") == "missing":
            dropped.append(_downgrade_unverified(finding))
            ids.append(finding_id(finding, index))
        else:
            kept.append(finding)
    return kept, dropped, ids


def _finalize_rows(reconciled, pages, records, max_candidates: int):
    findings = reconciled["findings"]
    resolved = reconciled["resolvedOk"]
    kept_findings, dropped_findings, ids_a = _classify_rows(
        findings, pages, records, max_candidates, 0,
    )
    kept_resolved, dropped_resolved, ids_b = _classify_rows(
        resolved, pages, records, max_candidates, len(findings),
    )
    active = kept_findings + dropped_findings + dropped_resolved
    return active, kept_resolved, ids_a + ids_b


def _benign_metadata(report) -> dict:
    if not isinstance(report, dict):
        return {}
    kept = {}
    for key, value in report.items():
        if key in _FINAL_REPORT_SKIP or key in _FORBIDDEN_RED_KEYS:
            continue
        kept[key] = value
    return kept


def _finalized_report(report, paper_id: str, digest: str, findings: list, resolved: list) -> dict:
    payload = {
        "schema": BLUE_REPORT_SCHEMA,
        "paperId": paper_id,
        "fileHash": digest,
        "findings": findings,
        "resolvedOk": resolved,
    }
    for key, value in _benign_metadata(report).items():
        if key not in payload:
            payload[key] = value
    return payload


def _write_report_json(path, payload: dict) -> None:
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        _fail(
            "output_write_failed",
            f"Unable to write report JSON: {exc}",
            exit_code=2,
            recovery_hint="Choose a writable output path.",
        )


def _zero_drop_payload(reconciled) -> dict:
    return {
        "summary": reconciled["summary"],
        "recoveredFindingIds": [
            str(item.get("reportNumber") or "")
            for item in reconciled["findings"]
            if item.get("zeroDropRecovered") is True
        ],
    }


def _note_downgrades(warnings: list[str], ids: list[str]) -> None:
    if ids:
        _push_warning(
            warnings,
            f"Auto-downgraded {len(ids)} unverified quote(s) to 확인필요.",
        )


def _require_clean_quotes(checks: dict) -> None:
    if checks.get("missingCount") != 0:
        _fail(
            "invalid_blue_report",
            "Finalized report still has missing quotes.",
            exit_code=2,
            recovery_hint="Auto-downgrade should clear every unverified quote.",
        )


def _finalize_payload(paper_identifier, digest, applied, downgraded_ids, final_checks,
                      reconciled, finalized, out_report_path, csv_result, warnings) -> dict:
    return {
        "schema": FINALIZE_SCHEMA,
        "ok": True,
        "paperId": paper_identifier,
        "fileHash": digest,
        "appliedRepairCount": applied,
        "autoDowngradedCount": len(downgraded_ids),
        "autoDowngradedFindingIds": downgraded_ids,
        "quoteCheck": final_checks,
        "zeroDrop": _zero_drop_payload(reconciled),
        "finalizedReport": finalized,
        "outReportPath": str(out_report_path) if out_report_path is not None else None,
        "csv": csv_result,
        "warnings": warnings,
    }


def finalize_blue_report(
    pdf_bytes,
    report,
    *,
    repairs=None,
    ledger=None,
    supplements=None,
    out_report_path=None,
    csv_path=None,
    max_candidates: int = 5,
    paper_id: str | None = None,
    file_hash: str | None = None,
    input_paths=(),
) -> dict:
    """Apply quote repairs, restore Zero-Drop rows, and downgrade unverified quotes.

    The returned ``finalizedReport`` is a ``falsify.blue-report.v1`` document whose
    quote gate is clean: every still-missing quote has been moved to
    ``unverifiedQuote`` and the finding abstains as ``확인필요``.
    """
    _require_max_candidates(max_candidates)
    raw = _require_pdf_bytes(pdf_bytes)
    _guard_finalize_leaks(report, ledger, repairs, supplements)
    _guard_output_collision(out_report_path, csv_path, input_paths)
    findings = _copied_report_findings(report)
    entries = _copied_ledger_entries(ledger, report)
    applied = _apply_all_repairs(findings, entries, repairs)
    supplement_records = None if supplements is None else _prepare_supplements(supplements)
    reconciled = reconcile_candidate_ledger(entries, findings)
    pages = _page_records(raw)
    final_findings, final_resolved, downgraded_ids = _finalize_rows(
        reconciled, pages, supplement_records, max_candidates,
    )
    final_checks = _quote_check(
        final_findings + final_resolved, pages, max_candidates, supplement_records,
    )
    _require_clean_quotes(final_checks)
    digest = file_hash or hashlib.sha256(raw).hexdigest()
    paper_identifier = paper_id or _report_paper_id(report, f"paper-{digest[:12]}")
    warnings = _ledger_override_warning(ledger, report)
    _note_downgrades(warnings, downgraded_ids)
    finalized = _finalized_report(
        report, paper_identifier, digest, final_findings, final_resolved,
    )
    if out_report_path is not None:
        _write_report_json(out_report_path, finalized)
    csv_result = None
    if csv_path is not None:
        csv_result = _emit_csv(
            csv_path,
            {"findings": final_findings, "resolvedOk": final_resolved},
            paper_identifier,
            _csv_defaults(report),
            warnings,
        )
    return _finalize_payload(
        paper_identifier, digest, applied, downgraded_ids, final_checks,
        reconciled, finalized, out_report_path, csv_result, warnings,
    )
