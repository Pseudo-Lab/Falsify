"""Unified headless agent JSON CLI for falsify RED/BLUE workflows.

Usage:
    python app/local/falsify_cli.py blue scan --pdf PATH [--supplement PATH ...] [--oracle] [--max-signals 50] [--digest-only] [--out JSON_PATH]
    python app/local/falsify_cli.py red targets --pdf PATH [--page N] [--query TEXT] [--include-baseline]
    python app/local/falsify_cli.py red apply --pdf PATH --ops OPS_JSON_OR_PATH --out-pdf BLIND_PDF [--out-gold GOLD_JSON] [--require-clean-stealth]
    python app/local/falsify_cli.py blind verify --pdf BLIND_PDF [--source-pdf SRC_PDF] [--supplement PATH ...]
    python app/local/falsify_cli.py arena score --gold GOLD_JSON --blue BLUE_JSON [--blue BLUE_JSON ...] [--baseline BASELINE_JSON] [--out OUT_JSON]
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib
import inspect
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

import pikepdf
import pymupdf

_HERE = Path(__file__).resolve()
_ROOT = _HERE.parents[2]
_EVAL_DIR = _ROOT / "tools" / "evaluation"
for _path in (str(_HERE.parent), str(_EVAL_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from agreement_selective import compute_krippendorff_alpha, compute_selective_prediction  # noqa: E402
from paper_blue_sensor import run_blue_sensor  # noqa: E402
from paper_chart_edit_service import ChartEditService  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402
from paper_evidence_text import _open_pdf  # noqa: E402
from paper_mcp import open_selected  # noqa: E402
import paper_red_mcp  # noqa: E402
from paper_stealth_audit import (  # noqa: E402
    BLINDNESS_META_PATTERNS,
    BLINDNESS_TEXT_PATTERNS,
    _extract_annot_strings,
    _metadata_corpus,
    audit_pdf_stealth,
)
from paper_supplement_audit import (  # noqa: E402
    _FORBIDDEN_RED_KEYS,
    audit_paper_with_supplements,
)
from paper_uri_mutator import _HINT_TOKENS  # noqa: E402

SCHEMA = "falsify.agent-cli.v1"
GOLD_LEDGER_SCHEMA = "falsify.red-gold-ledger.v1"
DIGEST_MAX_BYTES = 12 * 1024
SUPPORTED_SUPP_EXTS = frozenset({
    ".csv", ".tsv", ".json", ".md", ".txt", ".log", ".py", ".r", ".sql", ".pdf", ".docx",
})
_UNAMBIGUOUS_META_TOKENS = (
    "falsify", "red-plan", "candidate", "rationale", "falsify-red",
    "tampered", "answer-key", "answer_key", "변조", "정답", "의도적",
)
_LEDGER_SCHEMAS = frozenset({GOLD_LEDGER_SCHEMA, "falsify.coordinated-red-record.v1"})
_STOP_TOKENS = frozenset({
    "http", "https", "www", "doi.org", "doi", "org", "com", "net",
    "table", "figure", "page", "the", "and", "for", "was", "were", "with", "points", "target", "link",
})
_TOKEN_RE = re.compile(r"[A-Za-z0-9가-힣]+(?:\.[A-Za-z0-9가-힣]+)*(?:-[A-Za-z0-9가-힣]+)*")


class _CliError(Exception):
    def __init__(self, code: str, message: str, *, exit_code: int = 2,
                 recovery_hint: str = "", extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.recovery_hint = recovery_hint
        self.extra = extra or {}


class _JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str):
        raise _CliError(
            "invalid_arguments",
            message,
            exit_code=2,
            recovery_hint="Run with --help to inspect required flags and valid values.",
        )


def _error_payload(code: str, message: str, recovery_hint: str = "", extra: dict | None = None) -> dict:
    payload = {
        "schema": SCHEMA,
        "ok": False,
        "error": code,
        "message": message,
        "recoveryHint": recovery_hint,
    }
    if extra:
        payload.update(extra)
    return payload


def _emit(payload: dict, exit_code: int = 0) -> int:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    data = rendered.encode("utf-8")
    buf = getattr(sys.stdout, "buffer", None)
    if buf is not None:
        buf.write(data)
        buf.flush()
    else:
        sys.stdout.write(rendered)
        sys.stdout.flush()
    return exit_code


def _same_path(first: Path, second: Path) -> bool:
    return os.path.normcase(os.path.realpath(str(first))) == os.path.normcase(os.path.realpath(str(second)))


def _flatten_paths(groups) -> list[str]:
    if not groups:
        return []
    out = []
    for item in groups:
        if isinstance(item, (list, tuple)):
            out.extend(str(sub) for sub in item)
        else:
            out.append(str(item))
    return out


def _check_deadline(deadline: float | None):
    if deadline is not None and time.monotonic() > deadline:
        raise _CliError(
            "timeout",
            "Command exceeded configured timeout.",
            exit_code=124,
            recovery_hint="Increase --timeout or narrow the requested page/signal scope.",
        )


def _require_pdf_bytes(path_str: str) -> tuple[Path, bytes]:
    path = Path(path_str)
    if not path.is_file():
        raise _CliError(
            "file_not_found",
            f"PDF file not found: {path_str}",
            exit_code=2,
            recovery_hint="Verify the --pdf path exists and is readable.",
        )
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise _CliError("file_unreadable", f"Unable to read PDF: {exc}", exit_code=2) from None
    if not raw.startswith(b"%PDF-"):
        raise _CliError(
            "invalid_pdf",
            f"Input is not a valid PDF file: {path_str}",
            exit_code=2,
            recovery_hint="Provide an uncorrupted PDF starting with %PDF-.",
        )
    return path, raw


def _open_pdf_store(pdf_path: str) -> tuple[EvidenceStore, dict]:
    _require_pdf_bytes(pdf_path)
    store = EvidenceStore()
    try:
        summary = open_selected(store, pdf_path)
    except ValueError as exc:
        raise _CliError(
            "invalid_pdf",
            f"Failed to prepare PDF evidence store: {exc}",
            exit_code=2,
            recovery_hint="Ensure the PDF is unlocked, valid, and <= 25 MB.",
        ) from None
    return store, summary


def _find_red_keys(value, prefix: str = "") -> list[str]:
    found = []
    if isinstance(value, dict):
        if value.get("schema") in _LEDGER_SCHEMAS:
            found.append(f"{prefix}schema={value.get('schema')}")
        for key, val in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if key in _FORBIDDEN_RED_KEYS:
                found.append(path)
            found.extend(_find_red_keys(val, path))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            found.extend(_find_red_keys(item, f"{prefix}[{idx}]"))
    return found


def _extract_docx_text(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            xml_names = [n for n in archive.namelist() if n == "word/document.xml" or n.startswith("word/header") or n.startswith("word/footer")]
            if "word/document.xml" not in xml_names:
                raise _CliError("invalid_supplement", "DOCX supplement missing word/document.xml.", exit_code=2)
            parts = []
            for name in sorted(xml_names):
                root = ET.fromstring(archive.read(name))
                texts = [elem.text for elem in root.iter() if elem.tag.endswith("}t") and elem.text]
                if texts:
                    parts.append(" ".join(texts))
            return "\n".join(parts)
    except zipfile.BadZipFile:
        raise _CliError("invalid_supplement", "Supplement .docx is not a valid ZIP/DOCX archive.", exit_code=2) from None
    except ET.ParseError:
        raise _CliError("invalid_supplement", "Supplement .docx XML could not be parsed.", exit_code=2) from None


def _extract_pdf_pages(raw: bytes) -> list[str]:
    try:
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            return [doc[idx].get_text("text") or "" for idx in range(min(doc.page_count, 80))]
    except Exception as exc:
        raise _CliError("invalid_supplement", f"Supplement PDF unreadable: {exc}", exit_code=2) from None


def _read_json_file(path_str: str, label: str = "json"):
    path = Path(path_str)
    if not path.is_file():
        raise _CliError("file_not_found", f"Missing {label} file: {path_str}", exit_code=2)
    try:
        text = path.read_text(encoding="utf-8-sig")
        return json.loads(text)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _CliError("invalid_json", f"Invalid {label} JSON ({path_str}): {exc}", exit_code=2) from None


def _load_supplement_entry(path_str: str) -> dict:
    path = Path(path_str)
    if not path.is_file():
        raise _CliError("file_not_found", f"Supplement file not found: {path_str}", exit_code=2)
    ext = path.suffix.lower()
    if ext not in SUPPORTED_SUPP_EXTS:
        raise _CliError(
            "unsupported_supplement",
            f"Unsupported supplement extension '{ext}' for {path.name}.",
            exit_code=2,
            recovery_hint=f"Supported extensions: {', '.join(sorted(SUPPORTED_SUPP_EXTS))}",
        )
    raw = path.read_bytes()
    if ext == ".pdf":
        return {"name": path.name, "pages": _extract_pdf_pages(raw)}
    if ext == ".docx":
        return {"name": path.name, "text": _extract_docx_text(raw)}
    text = raw.decode("utf-8-sig", errors="replace")
    if ext == ".json":
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise _CliError("invalid_json", f"Invalid supplement JSON {path.name}: {exc}", exit_code=2) from None
        red_keys = _find_red_keys(parsed)
        if red_keys:
            raise _CliError(
                "forbidden_red_key",
                f"Supplement {path.name} contains forbidden RED/gold key(s): {', '.join(red_keys[:5])}",
                exit_code=3,
                recovery_hint="Remove RED ledger fields (before/after/patch/gold/plan) before running BLUE scan.",
                extra={"leaks": [{"surface": "supplement_json", "file": path.name, "keys": red_keys[:10]}]},
            )
    return {"name": path.name, "text": text}


def _trim_signal(sig: dict, excerpt_cap: int = 120, detail_cap: int = 160) -> dict:
    out = dict(sig)
    if isinstance(out.get("excerpt"), str):
        out["excerpt"] = out["excerpt"][:excerpt_cap]
    if isinstance(out.get("detail"), str):
        out["detail"] = out["detail"][:detail_cap]
    if isinstance(out.get("computed"), dict) and len(json.dumps(out["computed"], ensure_ascii=False)) > 240:
        out["computed"] = {"summary": str(out["computed"])[:160]}
    return out


def _strip_bulky_sensor_fields(sensor: dict) -> dict:
    compact = dict(sensor)
    uri = dict(compact.get("uriLinks") or {})
    uri.pop("links", None)
    compact["uriLinks"] = uri
    acro = dict(compact.get("acroForm") or {})
    acro.pop("fields", None)
    acro.pop("widgets", None)
    compact["acroForm"] = acro
    if isinstance(compact.get("oraclePack"), dict):
        op = dict(compact["oraclePack"])
        op["mismatchedReferences"] = list(op.get("mismatchedReferences") or [])[:5]
        op["retractedReferences"] = list(op.get("retractedReferences") or [])[:5]
        op["registryComparisons"] = list(op.get("registryComparisons") or [])[:5]
        compact["oraclePack"] = op
    compact["signals"] = [_trim_signal(s) for s in compact.get("signals") or []]
    return compact


def _fit_digest_budget(payload: dict) -> dict:
    for sig_cap in (25, 12, 6, 3):
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) < DIGEST_MAX_BYTES:
            return payload
        payload["sensor"]["signals"] = payload["sensor"].get("signals", [])[:sig_cap]
        if isinstance(payload.get("supplementAudit"), dict):
            sa = payload["supplementAudit"]
            sa["signals"] = sa.get("signals", [])[:sig_cap]
            sa["citedItems"] = sa.get("citedItems", [])[:10]
            sa["presentItems"] = sa.get("presentItems", [])[:10]
    if len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) >= DIGEST_MAX_BYTES:
        payload["sensor"].pop("oraclePack", None)
        payload["sensor"].pop("identifiers", None)
    return payload


def _compact_blue_payload(payload: dict) -> dict:
    out = dict(payload)
    out["sensor"] = _strip_bulky_sensor_fields(out.get("sensor") or {})
    if isinstance(out.get("supplementAudit"), dict):
        sa = dict(out["supplementAudit"])
        sa["signals"] = [_trim_signal(s) for s in sa.get("signals") or []]
        sa["citedItems"] = list(sa.get("citedItems") or [])[:20]
        sa["presentItems"] = list(sa.get("presentItems") or [])[:20]
        out["supplementAudit"] = sa
    return _fit_digest_budget(out)


def _write_json_out(out_path: str, payload: dict, protected_paths: list[str]):
    target = Path(out_path)
    for src in protected_paths:
        if src and _same_path(target, Path(src)):
            raise _CliError(
                "cannot_overwrite_input",
                f"--out path cannot match an input path: {out_path}",
                exit_code=2,
            )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise _CliError("output_write_failed", f"Unable to write output JSON: {exc}", exit_code=2) from None


def _visual_page_text(page) -> str:
    words = page.get_text("words") or []
    if not words:
        return page.get_text("text") or ""
    ordered = sorted(words, key=lambda w: (round((w[1] + w[3]) * 0.5 / 4.0), w[0]))
    lines, cur_band, cur_words = [], None, []
    for w in ordered:
        band = round((w[1] + w[3]) * 0.5 / 4.0)
        if cur_band is not None and band != cur_band:
            lines.append(" ".join(cur_words))
            cur_words = []
        cur_band = band
        cur_words.append(str(w[4]))
    if cur_words:
        lines.append(" ".join(cur_words))
    return "\n".join(lines)


def _cmd_blue_scan(args, deadline: float | None = None) -> tuple[dict, int]:
    if args.max_signals < 1 or args.max_signals > 100:
        raise _CliError("invalid_arguments", "--max-signals must be between 1 and 100.", exit_code=2)
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    _check_deadline(deadline)
    sensor_res = run_blue_sensor(
        pid, file_hash=fhash, max_signals=args.max_signals,
        include_external_oracle=bool(args.oracle), store=store,
    )
    supp_paths = _flatten_paths(args.supplement)
    supp_res = None
    if supp_paths:
        supp_entries = [_load_supplement_entry(p) for p in supp_paths]
        _check_deadline(deadline)
        raw = store.source_bytes(pid, fhash)
        with _open_pdf(raw) as doc:
            page_items = [
                {"id": f"p{idx}", "pageIndex": idx, "text": _visual_page_text(doc[idx])}
                for idx in range(min(doc.page_count, 80))
            ]
        try:
            supp_res = audit_paper_with_supplements(page_items, supp_entries)
        except ValueError as exc:
            if "forbidden_red_key" in str(exc):
                raise _CliError("forbidden_red_key", str(exc), exit_code=3) from None
            raise _CliError("supplement_audit_failed", str(exc), exit_code=2) from None
    payload = {
        "schema": SCHEMA,
        "ok": True,
        "command": "blue scan",
        "paperId": pid,
        "fileHash": fhash,
        "digestOnly": bool(args.digest_only),
        "sensor": sensor_res,
        "supplementAudit": supp_res,
    }
    if args.digest_only:
        payload = _compact_blue_payload(payload)
    if args.out:
        _write_json_out(args.out, payload, [args.pdf, *supp_paths])
    return payload, 0


def _matches_query(text: str, query_low: str) -> bool:
    return query_low in str(text or "").lower()


def _filter_targets(targets: dict, links: list[dict], query: str | None) -> tuple[dict, list[dict]]:
    if not query:
        return targets, links
    q = query.lower()
    paragraphs = [p for p in targets.get("paragraphs", []) if _matches_query(p.get("text"), q)]
    tables = [
        t for t in targets.get("tables", [])
        if _matches_query(t.get("caption"), q) or any(_matches_query(c.get("text"), q) for c in t.get("cells", []))
    ]
    figures = [f for f in targets.get("figures", []) if _matches_query(f.get("caption"), q)]
    filtered_links = [
        lnk for lnk in links if _matches_query(lnk.get("uri"), q) or _matches_query(lnk.get("visibleText"), q)
    ]
    return {**targets, "paragraphs": paragraphs, "tables": tables, "figures": figures}, filtered_links


def _list_optional_text_spans(pdf_bytes: bytes, page_index: int | None, query: str | None) -> list[dict]:
    try:
        mod = importlib.import_module("paper_text_span_mutator")
    except ImportError:
        return []
    fn = getattr(mod, "list_pdf_text_spans", None)
    if fn is None:
        return []
    return list(fn(pdf_bytes, page_index=page_index, query=query, limit=200).get("spans") or [])


def _cmd_red_targets(args, deadline: float | None = None) -> tuple[dict, int]:
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    page_count = summary["pageCount"]
    if args.page is not None and not 0 <= args.page < page_count:
        raise _CliError(
            "invalid_page",
            f"--page {args.page} out of range [0, {page_count - 1}].",
            exit_code=2,
            recovery_hint=f"Pass a 0-based page index between 0 and {page_count - 1}.",
        )
    _check_deadline(deadline)
    targets = paper_red_mcp._list_targets(store, pid, fhash, page_index=args.page)
    for idx, tbl in enumerate(targets.get("tables", [])):
        tbl["tableIndex"] = idx
    for idx, fig in enumerate(targets.get("figures", [])):
        fig["figureIndex"] = idx
    links_res = paper_red_mcp._list_links(store, pid, fhash, page_index=args.page)
    targets, filtered_links = _filter_targets(targets, links_res.get("links", []), args.query)
    spans = _list_optional_text_spans(store.source_bytes(pid, fhash), args.page, args.query)
    payload = {
        "schema": SCHEMA,
        "ok": True,
        "command": "red targets",
        "paperId": pid,
        "fileHash": fhash,
        "pageCount": page_count,
        "paragraphs": targets["paragraphs"],
        "textSpans": spans,
        "tables": targets["tables"],
        "figures": targets["figures"],
        "links": filtered_links,
    }
    if args.include_baseline:
        payload["baseline"] = run_blue_sensor(pid, file_hash=fhash, include_external_oracle=False, store=store)
    return payload, 0


def _load_ops_payload(ops_arg: str) -> list[dict]:
    stripped = str(ops_arg or "").strip()
    if stripped.startswith(("[", "{")):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise _CliError("invalid_operations", f"Invalid --ops JSON: {exc}", exit_code=2) from None
    else:
        parsed = _read_json_file(ops_arg, label="--ops")
    ops = parsed.get("operations") if isinstance(parsed, dict) else parsed
    if not isinstance(ops, list) or any(not isinstance(op, dict) for op in ops):
        raise _CliError(
            "invalid_operations",
            "--ops must decode to a JSON array of operation objects or {'operations': [...]}.",
            exit_code=2,
        )
    return ops


def _apply_text_span_ops(pdf_bytes: bytes, text_ops: list[dict]) -> tuple[bytes, list[dict], list[dict]]:
    if not text_ops:
        return pdf_bytes, [], []
    try:
        mod = importlib.import_module("paper_text_span_mutator")
    except ImportError:
        raise _CliError(
            "text_span_mutator_unavailable",
            "text-span operations require app/local/paper_text_span_mutator.py.",
            exit_code=2,
            recovery_hint="Use table-cell, chart-shape, region-replace, or uri-link ops, or merge paper_text_span_mutator.",
        ) from None
    mutator = getattr(mod, "mutate_pdf_text_spans", None)
    if mutator is None:
        raise _CliError("text_span_mutator_unavailable", "mutate_pdf_text_spans not found.", exit_code=2)
    try:
        res = mutator(pdf_bytes, text_ops)
    except ValueError as exc:
        details = getattr(exc, "details", None)
        if isinstance(details, dict):
            raise _CliError(
                getattr(exc, "code", "text_span_failed"),
                str(exc),
                exit_code=2,
                recovery_hint=str(details.get("recoveryHint") or "Inspect textSpans via 'red targets'."),
                extra={"nearestCandidates": list(details.get("nearestCandidates") or [])},
            ) from None
        raise _CliError(
            "red_apply_failed",
            f"Text-span operation failed: {exc}",
            exit_code=2,
            recovery_hint="Inspect pageIndex, spanId, and exact before text using 'red targets'.",
        ) from None
    if isinstance(res, (bytes, bytearray)):
        return bytes(res), [], []
    out_bytes = res.get("pdfBytes") or res.get("pdf_bytes") or pdf_bytes
    changes = list(res.get("changes") or [])
    regions = list(res.get("modifiedRegions") or [])
    return bytes(out_bytes), changes, regions


def _collect_regions(vis_result: dict, extra_regions: list[dict]) -> list[dict]:
    regions = list(paper_red_mcp._modified_regions(vis_result))
    for reg in extra_regions:
        if isinstance(reg, dict) and type(reg.get("pageIndex")) is int and isinstance(reg.get("bbox"), list):
            regions.append({"pageIndex": reg["pageIndex"], "bbox": reg["bbox"]})
    return regions


def _table_has_cell(store: EvidenceStore, pid: str, item_id: str, op: dict) -> bool:
    row, col, before = op.get("row"), op.get("column"), op.get("before")
    if type(row) is not int or type(col) is not int or not isinstance(before, str):
        return False
    cells = (store.read_item(pid, item_id).get("table") or {}).get("cells") or []
    return any(c.get("row") == row and c.get("column") == col and c.get("text") == before for c in cells)


def _find_matching_table_id(store: EvidenceStore, pid: str, tables: list[dict], op: dict) -> str | None:
    page_idx = op.get("pageIndex")
    cands = [t for t in tables if page_idx is None or t.get("pageIndex") == page_idx]
    tbl_idx = op.get("tableIndex")
    if type(tbl_idx) is int and 0 <= tbl_idx < len(tables):
        return tables[tbl_idx]["id"]
    bbox = op.get("bbox")
    if isinstance(bbox, list) and len(bbox) == 4:
        for cand in cands:
            if cand.get("bbox") == bbox:
                return cand["id"]
    for cand in cands:
        if _table_has_cell(store, pid, cand["id"], op):
            return cand["id"]
    return cands[0]["id"] if len(cands) == 1 else None


def _resolve_table_item_ids(store: EvidenceStore, pid: str, ops: list[dict]) -> list[dict]:
    tables = [m for m in paper_red_mcp._collect_all_items(store, pid) if m.get("type") == "table"]
    known_ids = {t["id"] for t in tables}
    resolved = []
    for op in ops:
        if op.get("kind") == "table-cell" and op.get("itemId") not in known_ids:
            matched_id = _find_matching_table_id(store, pid, tables, op)
            if matched_id:
                resolved.append({**op, "itemId": matched_id})
                continue
        resolved.append(op)
    return resolved


def _enrich_gold_changes(ops: list[dict], changes: list[dict], stealth: dict) -> list[dict]:
    by_id = {str(op["id"]): op for op in ops if isinstance(op, dict) and op.get("id")}
    stealth_ok = stealth.get("status") == "clean"
    enriched = []
    for idx, chg in enumerate(changes):
        op = by_id.get(str(chg.get("id") or "")) or (ops[idx] if idx < len(ops) and isinstance(ops[idx], dict) else {})
        merged = dict(chg)
        for key in ("world", "family", "difficulty", "rationale", "defectId"):
            if op.get(key) is not None and merged.get(key) is None:
                merged[key] = op[key]
        merged.setdefault("stealthPass", stealth_ok)
        enriched.append(merged)
    return enriched


def _cmd_red_apply(args, deadline: float | None = None) -> tuple[dict, int]:
    src_path, _ = _require_pdf_bytes(args.pdf)
    out_pdf = Path(args.out_pdf)
    if _same_path(src_path, out_pdf):
        raise _CliError(
            "cannot_overwrite_source",
            "--out-pdf must not resolve to the source --pdf path.",
            exit_code=2,
            recovery_hint="Write the blind PDF to a separate output path.",
        )
    if args.out_gold and (_same_path(src_path, Path(args.out_gold)) or _same_path(out_pdf, Path(args.out_gold))):
        raise _CliError("cannot_overwrite_input", "--out-gold must be distinct from --pdf and --out-pdf.", exit_code=2)
    ops = _load_ops_payload(args.ops)
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    _check_deadline(deadline)
    resolved_ops = _resolve_table_item_ids(store, pid, ops)
    text_ops = [op for op in resolved_ops if op.get("kind") == "text-span"]
    other_ops = [op for op in resolved_ops if op.get("kind") != "text-span"]
    try:
        applied = paper_red_mcp._apply_operations(
            store, ChartEditService(store), pid, fhash, other_ops,
        )
        src_bytes, edited_bytes, vis_result = applied[0], applied[1], applied[2]
    except ValueError as exc:
        raise _CliError(
            "red_apply_failed",
            f"Operation application failed: {exc}",
            exit_code=2,
            recovery_hint="Verify target IDs, rows/columns, before text, and URIs using 'red targets'.",
        ) from None
    edited_bytes, text_changes, text_regions = _apply_text_span_ops(edited_bytes, text_ops)
    regions = _collect_regions(vis_result, text_regions)
    stealth = audit_pdf_stealth(src_bytes, edited_bytes, modified_regions=regions)
    if args.require_clean_stealth and stealth["status"] == "detectable_artifact":
        raise _CliError(
            "stealth_audit_failed",
            "Stealth audit status is detectable_artifact; blind PDF not written.",
            exit_code=3,
            recovery_hint="Inspect stealthAudit.issues and tighten operation regions or metadata.",
            extra={"stealthAudit": stealth},
        )
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    out_pdf.write_bytes(edited_bytes)
    out_sha = hashlib.sha256(edited_bytes).hexdigest()
    all_changes = _enrich_gold_changes(ops, list(vis_result.get("changes") or []) + text_changes, stealth)
    if args.out_gold:
        ledger = {
            "schema": GOLD_LEDGER_SCHEMA,
            "paperId": pid,
            "sourceSha256": fhash,
            "outputSha256": out_sha,
            "blindPdfPath": str(out_pdf),
            "appliedCount": len(all_changes),
            "operations": ops,
            "changes": all_changes,
            "defects": all_changes,
            "stealthAudit": stealth,
            "verification": vis_result.get("verification"),
        }
        Path(args.out_gold).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_gold).write_text(json.dumps(ledger, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "schema": SCHEMA,
        "ok": True,
        "command": "red apply",
        "paperId": pid,
        "sourceSha256": fhash,
        "outputSha256": out_sha,
        "outPdf": str(out_pdf),
        "outGold": args.out_gold,
        "appliedCount": len(all_changes),
        "stealthAudit": stealth,
        "verification": vis_result.get("verification"),
    }, 0


def _delegate_arena(fn_name: str, **kwargs):
    try:
        mod = importlib.import_module("arena_runner")
    except ImportError:
        return None
    fn = getattr(mod, fn_name, None)
    if fn is None:
        return None
    params = inspect.signature(fn).parameters
    accepted = {k: v for k, v in kwargs.items() if k in params and v is not None}
    return fn(**accepted)


def _scan_text_patterns(text: str, surface: str, page_index: int | None = None) -> list[dict]:
    leaks = []
    for pat in BLINDNESS_TEXT_PATTERNS:
        m = pat.search(text or "")
        if m:
            item = {"code": "blindness_hint_leak", "surface": surface, "match": m.group(0)}
            if page_index is not None:
                item["pageIndex"] = page_index
            leaks.append(item)
    return leaks


def _inspect_pdf_blindness_standalone(blind_bytes: bytes) -> list[dict]:
    leaks = []
    with pymupdf.open(stream=blind_bytes, filetype="pdf") as doc:
        corpus = _metadata_corpus(blind_bytes, doc)
        for tok in _UNAMBIGUOUS_META_TOKENS:
            if tok in corpus:
                leaks.append({"code": "metadata_leak", "surface": "metadata", "token": tok})
        for pat in BLINDNESS_META_PATTERNS:
            if pat.search(corpus):
                leaks.append({"code": "metadata_leak", "surface": "metadata", "pattern": pat.pattern})
        for idx in range(len(doc)):
            page = doc[idx]
            annot_text = "\n".join(_extract_annot_strings(page))
            low_annot = annot_text.lower()
            for tok in _HINT_TOKENS:
                if tok in low_annot:
                    leaks.append({"code": "blindness_hint_leak", "surface": "annotation", "pageIndex": idx, "token": tok})
            leaks.extend(_scan_text_patterns(page.get_text("text") or "", "text", page_index=idx))
    return leaks


def _inspect_pdf_with_source(src_bytes: bytes, blind_bytes: bytes) -> list[dict]:
    audit = audit_pdf_stealth(src_bytes, blind_bytes, modified_regions=None)
    leaks = []
    for issue in audit.get("issues", []):
        if issue.get("code") in ("metadata_leak", "blindness_hint_leak") or issue.get("severity") == "detectable_artifact":
            leaks.append(issue)
    return leaks


def _inspect_supplement_blindness(supp_paths: list[str]) -> list[dict]:
    leaks = []
    for p_str in supp_paths:
        path = Path(p_str)
        if not path.is_file():
            raise _CliError("file_not_found", f"Supplement file not found: {p_str}", exit_code=2)
        ext = path.suffix.lower()
        if ext not in SUPPORTED_SUPP_EXTS:
            raise _CliError("unsupported_supplement", f"Unsupported supplement extension: {ext}", exit_code=2)
        raw = path.read_bytes()
        if ext == ".json":
            try:
                parsed = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise _CliError("invalid_json", f"Invalid supplement JSON {path.name}: {exc}", exit_code=2) from None
            red_keys = _find_red_keys(parsed)
            if red_keys:
                leaks.append({"code": "forbidden_red_key", "surface": "supplement_json", "file": path.name, "keys": red_keys[:10]})
            text = json.dumps(parsed, ensure_ascii=False)
        elif ext == ".pdf":
            text = "\n".join(_extract_pdf_pages(raw))
        elif ext == ".docx":
            text = _extract_docx_text(raw)
        else:
            text = raw.decode("utf-8-sig", errors="replace")
        for item in _scan_text_patterns(text, f"supplement:{path.name}"):
            leaks.append({**item, "file": path.name})
    return leaks


def _load_blind_verify_supplements(supp_paths: list[str]) -> list[dict]:
    items = []
    for p_str in supp_paths:
        path = Path(p_str)
        if not path.is_file():
            raise _CliError("file_not_found", f"Supplement file not found: {p_str}", exit_code=2)
        ext = path.suffix.lower()
        if ext not in SUPPORTED_SUPP_EXTS:
            raise _CliError("unsupported_supplement", f"Unsupported supplement extension: {ext}", exit_code=2)
        raw = path.read_bytes()
        if ext == ".pdf":
            text = "\n".join(_extract_pdf_pages(raw))
        elif ext == ".docx":
            text = _extract_docx_text(raw)
        else:
            text = raw.decode("utf-8-sig", errors="replace")
        items.append({"name": path.name, "text": text})
    return items


def _cmd_blind_verify(args, deadline: float | None = None) -> tuple[dict, int]:
    _blind_path, blind_bytes = _require_pdf_bytes(args.pdf)
    src_bytes = _require_pdf_bytes(args.source_pdf)[1] if args.source_pdf else None
    supp_paths = _flatten_paths(args.supplement)
    supp_dicts = _load_blind_verify_supplements(supp_paths)
    _check_deadline(deadline)
    delegated = _delegate_arena(
        "verify_blind_bundle",
        blind_pdf_bytes=blind_bytes,
        blind_supplements=supp_dicts,
        source_pdf_bytes=src_bytes,
        blind_pdf=args.pdf,
        pdf_path=args.pdf,
        source_pdf=args.source_pdf,
        supplements=supp_paths,
        supplement_paths=supp_paths,
    )
    if isinstance(delegated, dict):
        leaks = list(delegated.get("leaks") or delegated.get("issues") or [])
        clean = bool(delegated.get("clean", delegated.get("blindClean", not leaks)))
        payload = {"schema": SCHEMA, "ok": clean, "command": "blind verify", "clean": clean, "leaks": leaks, "delegated": delegated}
        return (payload, 0) if clean else ({**payload, "error": "blindness_leak_detected", "recoveryHint": "Remove leaked RED metadata, annotations, or supplement keys."}, 3)
    leaks = _inspect_pdf_with_source(src_bytes, blind_bytes) if src_bytes is not None else _inspect_pdf_blindness_standalone(blind_bytes)
    leaks.extend(_inspect_supplement_blindness(supp_paths))
    if leaks:
        return _error_payload(
            "blindness_leak_detected",
            f"Detected {len(leaks)} blindness/stealth leak(s).",
            recovery_hint="Strip RED metadata, annotations, and forbidden JSON keys before handing bundle to BLUE.",
            extra={"command": "blind verify", "clean": False, "leaks": leaks},
        ), 3
    return {
        "schema": SCHEMA,
        "ok": True,
        "command": "blind verify",
        "clean": True,
        "leaks": [],
        "pdfSha256": hashlib.sha256(blind_bytes).hexdigest(),
    }, 0


def _extract_gold_items(gold_raw) -> list[dict]:
    if isinstance(gold_raw, list):
        items = gold_raw
    elif isinstance(gold_raw, dict):
        items = (
            gold_raw.get("operations")
            or gold_raw.get("changes")
            or gold_raw.get("gold")
            or gold_raw.get("entries")
            or gold_raw.get("items")
            or []
        )
    else:
        raise _CliError("invalid_gold", "Gold JSON must be a dict or list of defect entries.", exit_code=2)
    out = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        out.append({
            "id": str(item.get("id") or f"gold-{idx + 1}"),
            "kind": item.get("kind") or item.get("defect_type") or "",
            "pageIndex": item.get("pageIndex"),
            "itemId": item.get("itemId"),
            "bbox": item.get("bbox"),
            "texts": [
                str(item[k]) for k in ("after", "before", "afterUri", "beforeUri", "quote", "excerpt", "rationale", "location")
                if item.get(k) is not None and str(item.get(k)).strip()
            ],
        })
    return out


def _raw_blue_items(blue_raw) -> list:
    if isinstance(blue_raw, list):
        return blue_raw
    if not isinstance(blue_raw, dict):
        raise _CliError("invalid_blue", "Blue JSON must be a dict or list of findings.", exit_code=2)
    if isinstance(blue_raw.get("findings"), list):
        return blue_raw["findings"]
    if isinstance(blue_raw.get("signals"), list):
        return blue_raw["signals"]
    if isinstance(blue_raw.get("sensor"), dict):
        items = list(blue_raw["sensor"].get("signals") or [])
        if isinstance(blue_raw.get("supplementAudit"), dict):
            items.extend(blue_raw["supplementAudit"].get("signals") or [])
        return items
    return []


def _normalize_blue_item(item: dict, idx: int) -> dict | None:
    verdict = str(item.get("verdict") or item.get("verdictLabel") or "defect").strip().lower()
    if verdict in ("clean", "ok", "supported", "맞음"):
        return None
    texts = []
    for k in ("quote", "excerpt", "detail", "rationale", "location"):
        if item.get(k) is not None and str(item.get(k)).strip():
            texts.append(str(item[k]))
    for k in ("reported", "computed"):
        if item.get(k) is not None:
            texts.append(json.dumps(item[k], ensure_ascii=False))
    abstained = verdict in ("needs_check", "uncertain", "needs-verification", "확인필요") or item.get("abstained") is True
    return {
        "id": str(item.get("id") or f"finding-{idx + 1}"),
        "pageIndex": item.get("pageIndex"),
        "itemId": item.get("itemId"),
        "bbox": item.get("bbox"),
        "verdict": verdict,
        "abstained": abstained,
        "texts": texts,
    }


def _extract_blue_findings(blue_raw) -> list[dict]:
    out = []
    for idx, item in enumerate(_raw_blue_items(blue_raw)):
        if isinstance(item, dict):
            norm = _normalize_blue_item(item, idx)
            if norm is not None:
                out.append(norm)
    return out


def _token_set(texts: list[str]) -> set[str]:
    tokens = set()
    for text in texts:
        for tok in _TOKEN_RE.findall(str(text).lower()):
            if tok not in _STOP_TOKENS and len(tok) >= 2:
                tokens.add(tok)
            if "-" in tok:
                for sub in tok.split("-"):
                    if sub not in _STOP_TOKENS and len(sub) >= 2:
                        tokens.add(sub)
    return tokens


def _finding_matches_gold(finding: dict, gold: dict) -> bool:
    if finding.get("itemId") and gold.get("itemId") and finding["itemId"] == gold["itemId"]:
        return True
    f_page, g_page = finding.get("pageIndex"), gold.get("pageIndex")
    if f_page is not None and g_page is not None and f_page != g_page:
        return False
    f_joined = " ".join(finding.get("texts", [])).lower()
    for g_text in gold.get("texts", []):
        low = g_text.lower().strip()
        if len(low) >= 3 and low in f_joined:
            return True
    f_toks = _token_set(finding.get("texts", []))
    g_toks = _token_set(gold.get("texts", []))
    if not f_toks or not g_toks:
        return False
    overlap = len(f_toks & g_toks)
    return overlap >= 2 or (overlap / min(len(f_toks), len(g_toks))) >= 0.5


def _score_single_blue(name: str, findings: list[dict], gold_items: list[dict]) -> dict:
    matched_gold, eval_items, matches = set(), [], []
    tp, fp = 0, 0
    for finding in findings:
        hit_idx = next((i for i, g in enumerate(gold_items) if _finding_matches_gold(finding, g)), None)
        is_tp = hit_idx is not None
        if is_tp:
            tp += 1
            matched_gold.add(hit_idx)
            matches.append({"findingId": finding["id"], "goldId": gold_items[hit_idx]["id"]})
        else:
            fp += 1
        eval_items.append({
            "tier": 2 if finding["abstained"] else 1,
            "isCorrect": is_tp,
        })
    fn = max(0, len(gold_items) - len(matched_gold))
    precision = round(tp / (tp + fp), 4) if (tp + fp) else 0.0
    recall = round(len(matched_gold) / len(gold_items), 4) if gold_items else 0.0
    f1 = round((2 * precision * recall) / (precision + recall), 4) if (precision + recall) else 0.0
    selective = compute_selective_prediction(eval_items)
    return {
        "name": name,
        "findingCount": len(findings),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "matchedGoldIds": [gold_items[i]["id"] for i in sorted(matched_gold)],
        "matches": matches,
        "selective": selective,
    }


def _build_agreement_units(runs_findings: list[list[dict]], gold_items: list[dict]) -> list[dict]:
    units = []
    for gold in gold_items:
        ratings = []
        for findings in runs_findings:
            hits = [f for f in findings if _finding_matches_gold(f, gold)]
            if not hits:
                ratings.append("undetected")
            elif all(h["abstained"] for h in hits):
                ratings.append("uncertain")
            else:
                ratings.append("detected")
        units.append({"unitId": gold["id"], "ratings": ratings})
    return units


def _cmd_arena_score(args, deadline: float | None = None) -> tuple[dict, int]:
    blue_paths = _flatten_paths(args.blue)
    if not blue_paths:
        raise _CliError("invalid_arguments", "At least one --blue JSON path is required.", exit_code=2)
    gold_raw = _read_json_file(args.gold, label="--gold")
    blue_raws = [_read_json_file(p, label="--blue") for p in blue_paths]
    baseline_raw = _read_json_file(args.baseline, label="--baseline") if args.baseline else None
    _check_deadline(deadline)
    delegated = _delegate_arena(
        "evaluate_arena_match",
        gold_ledger=gold_raw,
        blue_runs=blue_raws,
        baseline_signals=baseline_raw,
        gold_path=args.gold,
        blue_paths=blue_paths,
        baseline_path=args.baseline,
        gold=gold_raw,
        blues=blue_raws,
        baseline=baseline_raw,
    )
    if isinstance(delegated, dict):
        payload = {"schema": SCHEMA, "ok": True, "command": "arena score", "delegated": True, **delegated}
    else:
        gold_items = _extract_gold_items(gold_raw)
        runs_findings = [_extract_blue_findings(b) for b in blue_raws]
        run_scores = [_score_single_blue(Path(p).name, f, gold_items) for p, f in zip(blue_paths, runs_findings)]
        units = _build_agreement_units(runs_findings, gold_items)
        nominal = compute_krippendorff_alpha(units, level="nominal")
        ordinal = compute_krippendorff_alpha(units, level="ordinal")
        baseline_score = _score_single_blue(Path(args.baseline).name, _extract_blue_findings(baseline_raw), gold_items) if baseline_raw is not None else None
        payload = {
            "schema": SCHEMA,
            "ok": True,
            "command": "arena score",
            "goldCount": len(gold_items),
            "runs": run_scores,
            "agreement": {"nominal": nominal, "ordinal": ordinal},
            "baseline": baseline_score,
        }
    if args.out:
        _write_json_out(args.out, payload, [args.gold, *blue_paths, *([args.baseline] if args.baseline else [])])
    return payload, 0


def _add_blue_parser(subparsers, parent):
    blue = subparsers.add_parser("blue", parents=[parent], help="BLUE verification commands")
    blue_sub = blue.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    scan = blue_sub.add_parser("scan", parents=[parent], help="Run Layer 0 BLUE sensor + optional supplement audit")
    scan.add_argument("--pdf", required=True)
    scan.add_argument("--supplement", action="append", nargs="+")
    scan.add_argument("--oracle", action="store_true")
    scan.add_argument("--max-signals", type=int, default=50)
    scan.add_argument("--digest-only", action="store_true")
    scan.add_argument("--out")


def _add_red_parser(subparsers, parent):
    red = subparsers.add_parser("red", parents=[parent], help="RED authoring commands")
    red_sub = red.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    targets = red_sub.add_parser("targets", parents=[parent], help="List addressable targets and baseline signals")
    targets.add_argument("--pdf", required=True)
    targets.add_argument("--page", type=int)
    targets.add_argument("--query")
    targets.add_argument("--include-baseline", action="store_true")
    apply_cmd = red_sub.add_parser("apply", parents=[parent], help="Apply coordinated RED edits to a blind PDF")
    apply_cmd.add_argument("--pdf", required=True)
    apply_cmd.add_argument("--ops", required=True)
    apply_cmd.add_argument("--out-pdf", required=True)
    apply_cmd.add_argument("--out-gold")
    apply_cmd.add_argument("--require-clean-stealth", action="store_true")


def _add_blind_and_arena_parsers(subparsers, parent):
    blind = subparsers.add_parser("blind", parents=[parent], help="Blindness verification commands")
    blind_sub = blind.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    verify = blind_sub.add_parser("verify", parents=[parent], help="Verify blind bundle has zero RED leaks")
    verify.add_argument("--pdf", required=True)
    verify.add_argument("--source-pdf")
    verify.add_argument("--supplement", action="append", nargs="+")

    arena = subparsers.add_parser("arena", parents=[parent], help="Arena scoring commands")
    arena_sub = arena.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    score = arena_sub.add_parser("score", parents=[parent], help="Score BLUE reports against sealed gold")
    score.add_argument("--gold", required=True)
    score.add_argument("--blue", required=True, action="append", nargs="+")
    score.add_argument("--baseline")
    score.add_argument("--out")


def _build_parser() -> _JsonArgumentParser:
    shared = _JsonArgumentParser(add_help=False)
    shared.add_argument("--timeout", type=float, default=argparse.SUPPRESS)
    root = _JsonArgumentParser(prog="python app/local/falsify_cli.py", description=__doc__)
    root.add_argument("--timeout", type=float, default=None)
    sub = root.add_subparsers(dest="group", parser_class=_JsonArgumentParser)
    _add_blue_parser(sub, shared)
    _add_red_parser(sub, shared)
    _add_blind_and_arena_parsers(sub, shared)
    return root


_DISPATCH = {
    ("blue", "scan"): _cmd_blue_scan,
    ("red", "targets"): _cmd_red_targets,
    ("red", "apply"): _cmd_red_apply,
    ("blind", "verify"): _cmd_blind_verify,
    ("arena", "score"): _cmd_arena_score,
}


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        handler = _DISPATCH.get((getattr(args, "group", None), getattr(args, "action", None)))
        if handler is None:
            raise _CliError(
                "invalid_arguments",
                "Specify one of: blue scan, red targets, red apply, blind verify, arena score.",
                exit_code=2,
                recovery_hint="Run with --help to view command groups and actions.",
            )
        timeout_val = getattr(args, "timeout", None)
        deadline = (time.monotonic() + timeout_val) if timeout_val is not None and timeout_val > 0 else None
        payload, code = handler(args, deadline)
        return _emit(payload, code)
    except _CliError as exc:
        return _emit(_error_payload(exc.code, exc.message, exc.recovery_hint, exc.extra), exc.exit_code)
    except TimeoutError:
        return _emit(_error_payload("timeout", "Operation timed out.", "Retry with a higher --timeout."), 124)
    except SystemExit as exc:
        return 0 if exc.code in (None, 0) else int(exc.code) if isinstance(exc.code, int) else 2
    except Exception as exc:
        return _emit(_error_payload("internal_error", f"{type(exc).__name__}: {exc}", "Inspect inputs and flags."), 2)


if __name__ == "__main__":
    raise SystemExit(main())
