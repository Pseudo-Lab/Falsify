"""Unified headless agent JSON CLI for falsify RED/BLUE workflows.

Usage:
    python app/local/falsify_cli.py blue scan --pdf PATH [--supplement PATH ...] [--oracle] [--figure-forensics] [--flow-triage] [--internal-consistency] [--meta-tables] [--pdf-security] [--recompute-raw] [--audit-code] [--cache-dir DIR] [--sarif SARIF_PATH] [--max-signals 50] [--digest-only] [--out JSON_PATH]
    python app/local/falsify_cli.py blue scan-workspace --workspace DIR [--max-papers 32] [--max-signals-per-paper 25] [--figure-forensics] [--no-recompute-raw] [--no-flow-triage] [--no-internal-consistency] [--cache-dir DIR] [--out JSON_PATH]
    python app/local/falsify_cli.py blue validate --pdf BLIND_PDF --report BLUE_REPORT [--supplement PATH ...] [--ledger CANDIDATES_JSON] [--emit-repair-pack] [--csv OUT_CSV] [--out JSON_PATH]
    python app/local/falsify_cli.py blue finalize --pdf BLIND_PDF --report BLUE_REPORT [--repairs REPAIRS_JSON] [--supplement PATH ...] [--ledger CANDIDATES_JSON] [--out-report FINAL_REPORT_JSON] [--csv OUT_CSV] [--sarif SARIF_PATH] [--out JSON_PATH]
    python app/local/falsify_cli.py blue ensemble --report PATH --report PATH [--report PATH ...] [--rater-id ID ...] [--pdf BLIND_PDF] [--supplement PATH ...] [--ledger CANDIDATES_JSON] [--min-consensus K] [--csv OUT_CSV] [--sarif SARIF_PATH] [--out JSON_PATH]
    python app/local/falsify_cli.py red targets --pdf PATH [--page N] [--query TEXT] [--include-baseline]
    python app/local/falsify_cli.py red plan --pdf PATH [--supplement PATH ...] [--target-difficulty L1|L2|L3|L4] [--max-bundles 5] [--claim TEXT] [--red-brief BRIEF_JSON_OR_PATH] [--out JSON_PATH]
    python app/local/falsify_cli.py red simulate --pdf PATH --ops OPS_JSON_OR_PATH [--supplement PATH ...] [--max-signals 50] [--out JSON_PATH]
    python app/local/falsify_cli.py red trace --pdf PATH --claim TEXT [--supplement PATH ...] [--max-occurrences 40] [--out JSON_PATH]
    python app/local/falsify_cli.py red apply --pdf PATH --ops OPS_JSON_OR_PATH --out-pdf BLIND_PDF [--out-gold GOLD_JSON] [--out-supplement-dir DIR] [--supplement PATH ...] [--min-difficulty L1|L2|L3|L4] [--require-clean-stealth]
    python app/local/falsify_cli.py blind verify --pdf BLIND_PDF [--source-pdf SRC_PDF] [--supplement PATH ...]
    python app/local/falsify_cli.py arena score --gold GOLD_JSON --blue BLUE_JSON [--blue BLUE_JSON ...] [--baseline BASELINE_JSON] [--out OUT_JSON]
    python app/local/falsify_cli.py arena run-round --pdf BLIND_PDF --agent-cmd EXE [--agent-arg VALUE ...] [--source-pdf SRC_PDF] [--supplement PATH ...] [--gold GOLD_JSON] [--baseline BASELINE_JSON] [--agent-timeout 180] [--runs 1] [--out OUT_JSON]
    python app/local/falsify_cli.py arena distill --round ROUND_JSON [--gold GOLD_JSON] [--max-rules 40] [--out PATCH_JSON]
    python app/local/falsify_cli.py arena duel --source-pdf SRC_PDF --red-cmd EXE [--red-arg VALUE ...] --blue-cmd EXE [--blue-arg VALUE ...] [--supplement PATH ...] [--holdout-pdf PDF ...] [--red-harness HARNESS_JSON] [--blue-harness HARNESS_JSON] [--min-difficulty L1|L2|L3|L4] [--runs 1] [--agent-timeout 180] [--max-rules 40] [--no-validate-quotes] [--out OUT_JSON]
    python app/local/falsify_cli.py arena apply-patch --harness HARNESS_JSON --patch PATCH_JSON [--role blue|red] [--max-generations 3] [--baseline-holdout-fp N] [--candidate-holdout-fp N] [--max-instructions-chars 12000] [--compact-rules] [--out OUT_JSON]
    python app/local/falsify_cli.py arena evolve --source-pdf SRC_PDF [SRC_PDF ...] [--supplement PATH ...] [--holdout-pdf PDF ...] [--harness HARNESS_JSON] [--red-harness RED_HARNESS_JSON] [--role blue|red|both] --red-cmd EXE [--red-arg VALUE ...] --blue-cmd EXE [--blue-arg VALUE ...] [--generations 3] [--min-difficulty L1|L2|L3|L4] [--runs 1] [--agent-timeout 180] [--max-rules 40] [--max-recall-drop 0.0] [--compact-rules] [--checkpoint-dir DIR] [--resume] [--max-total-seconds S] [--out OUT_JSON] [--out-harness HARNESS_OUT] [--out-red-harness RED_HARNESS_OUT]
    python app/local/falsify_cli.py arena tournament --source-pdf SRC_PDF [SRC_PDF ...] --red-entry SPEC [--red-entry SPEC ...] --blue-entry SPEC [--blue-entry SPEC ...] [--supplement PATH ...] [--holdout-pdf PDF ...] [--min-difficulty L1|L2|L3|L4] [--agent-timeout 180] [--no-validate-quotes] [--out OUT_JSON]
    python app/local/falsify_cli.py arena benchmark [--mode sensor|agent] [--agent-cmd EXE] [--agent-arg VALUE ...] [--case CASE_ID ...] [--baseline-report REPORT_JSON] [--max-recall-drop 0.0] [--allow-holdout-fp-increase] [--out OUT_JSON]
    python app/local/falsify_cli.py schemas [--id SCHEMA_ID] [--out OUT_JSON]
    python app/local/falsify_cli.py mcp-config (--pdf PATH | --workspace DIR) [--role blue|red|both] [--analysis] [--oracle] [--supplement PATH ...] [--format json]
"""
from __future__ import annotations

import argparse
import base64
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
from blue_report_validate import BlueReportError, finalize_blue_report, validate_blue_report  # noqa: E402
from paper_blue_sensor import run_blue_sensor  # noqa: E402
from paper_chart_edit_service import ChartEditService  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402
from paper_evidence_text import _open_pdf  # noqa: E402
import paper_mcp  # noqa: E402
from paper_mcp import open_selected  # noqa: E402
import paper_red_detectability  # noqa: E402
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
from paper_tabular_notebook_loader import parse_ipynb_notebook, parse_xlsx_workbook  # noqa: E402
from paper_uri_mutator import _HINT_TOKENS  # noqa: E402

SCHEMA = "falsify.agent-cli.v1"
MCP_CONFIG_SCHEMA = "falsify.mcp-config.v1"
MCP_SERVER_KEY = "falsify-paper-evidence"
RED_MCP_SERVER_KEY = "falsify-paper-red"
_DIFFICULTY_RANK = {"L1": 1, "L2": 2, "L3": 3, "L4": 4}
MCP_REGISTERS = ("claude", "codex", "gemini")
MCP_WORKSPACE_WARNING = "workspace flag requires the w7-c2-mcp-workspace merge"
GOLD_LEDGER_SCHEMA = "falsify.red-gold-ledger.v1"
DIGEST_MAX_BYTES = 12 * 1024
SUPPORTED_SUPP_EXTS = frozenset({
    ".csv", ".tsv", ".json", ".md", ".txt", ".log",
    ".py", ".r", ".rmd", ".qmd", ".sql", ".pdf", ".docx", ".xlsx", ".ipynb",
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


def _decode_structured_supplement(path: Path, ext: str, raw: bytes) -> dict:
    try:
        if ext == ".xlsx":
            parsed = parse_xlsx_workbook(raw, name=path.name)
            return {
                "name": path.name,
                "text": parsed.get("text") or "",
                "sheets": parsed.get("sheets") or [],
                "formulaSignals": parsed.get("formulaSignals") or [],
                "bytes": raw,
            }
        parsed = parse_ipynb_notebook(raw, name=path.name)
        return {
            "name": path.name,
            "text": parsed.get("text") or "",
            "notebook": parsed,
            "bytes": raw,
        }
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError(
                "forbidden_red_key",
                f"Supplement {path.name} contains forbidden RED/gold key(s).",
                exit_code=3,
                recovery_hint="Remove RED ledger fields (before/after/patch/gold/plan) before running BLUE scan.",
                extra={"leaks": [{"surface": "supplement", "file": path.name}]},
            ) from None
        raise _CliError("invalid_supplement", f"Invalid supplement {path.name}: {exc}", exit_code=2) from None


def _load_json_supplement_entry(path: Path, text: str) -> dict:
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
    if ext in (".xlsx", ".ipynb"):
        return _decode_structured_supplement(path, ext, raw)
    text = raw.decode("utf-8-sig", errors="replace")
    if ext == ".json":
        return _load_json_supplement_entry(path, text)
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
    if isinstance(compact.get("internalConsistency"), dict):
        ic = dict(compact["internalConsistency"])
        ic["signals"] = [_trim_signal(s) for s in ic.get("signals") or []]
        ic["triageHints"] = list(ic.get("triageHints") or [])[:5]
        compact["internalConsistency"] = ic
    compact["signals"] = [_trim_signal(s) for s in compact.get("signals") or []]
    return compact


def _cap_audit_signals(payload: dict, key: str, sig_cap: int) -> None:
    audit = payload.get(key)
    if isinstance(audit, dict) and isinstance(audit.get("signals"), list):
        audit["signals"] = audit["signals"][:sig_cap]


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
        _cap_audit_signals(payload, "rawDatasetAudit", sig_cap)
        _cap_audit_signals(payload, "codeAudit", sig_cap)
    if len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) >= DIGEST_MAX_BYTES:
        payload["sensor"].pop("oraclePack", None)
        payload["sensor"].pop("identifiers", None)
    return payload


def _trim_audit_doc(audit_doc) -> dict | None:
    if not isinstance(audit_doc, dict):
        return None
    trimmed = dict(audit_doc)
    trimmed["signals"] = [
        _trim_signal(item) if isinstance(item, dict) else item
        for item in (audit_doc.get("signals") or [])
    ]
    return trimmed


def _compact_blue_payload(payload: dict) -> dict:
    out = dict(payload)
    out["sensor"] = _strip_bulky_sensor_fields(out.get("sensor") or {})
    if isinstance(out.get("supplementAudit"), dict):
        sa = dict(out["supplementAudit"])
        sa["signals"] = [_trim_signal(s) for s in sa.get("signals") or []]
        sa["citedItems"] = list(sa.get("citedItems") or [])[:20]
        sa["presentItems"] = list(sa.get("presentItems") or [])[:20]
        out["supplementAudit"] = sa
    for key in ("rawDatasetAudit", "codeAudit"):
        trimmed = _trim_audit_doc(out.get(key))
        if trimmed is not None:
            out[key] = trimmed
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


def _scan_page_items(store: EvidenceStore, pid: str, fhash: str) -> list[dict]:
    raw = store.source_bytes(pid, fhash)
    with _open_pdf(raw) as doc:
        return [
            {"id": f"p{idx}", "pageIndex": idx, "text": _visual_page_text(doc[idx])}
            for idx in range(min(doc.page_count, 80))
        ]


def _audit_supplements(page_items: list[dict], supp_entries: list[dict]):
    try:
        return audit_paper_with_supplements(page_items, supp_entries)
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", str(exc), exit_code=3) from None
        raise _CliError("supplement_audit_failed", str(exc), exit_code=2) from None


def _run_raw_dataset_audit(page_items: list[dict], supp_entries: list[dict], max_signals: int):
    try:
        module = importlib.import_module("paper_raw_dataset_audit")
    except ImportError:
        raise _CliError(
            "raw_dataset_audit_unavailable",
            "app/local/paper_raw_dataset_audit.py is not installed.",
            exit_code=2,
            recovery_hint="Install app/local/paper_raw_dataset_audit.py or omit --recompute-raw.",
        ) from None
    try:
        return module.audit_raw_datasets(page_items, supp_entries, max_signals=max_signals)
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", str(exc), exit_code=3) from None
        raise


def _run_code_supplement_audit(page_items: list[dict], supp_entries: list[dict], max_signals: int):
    try:
        module = importlib.import_module("paper_code_audit")
    except ImportError:
        raise _CliError(
            "code_audit_unavailable",
            "app/local/paper_code_audit.py is not installed.",
            exit_code=2,
            recovery_hint="Install app/local/paper_code_audit.py or omit --audit-code.",
        ) from None
    try:
        return module.audit_code_supplements(page_items, supp_entries, max_signals=max_signals)
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", str(exc), exit_code=3) from None
        raise


def _scan_attached_audits(store, pid, fhash, args, deadline):
    supp_paths = _flatten_paths(args.supplement)
    if not supp_paths:
        return supp_paths, None, None, None
    supp_entries = [_load_supplement_entry(p) for p in supp_paths]
    _check_deadline(deadline)
    page_items = _scan_page_items(store, pid, fhash)
    supp_res = _audit_supplements(page_items, supp_entries)
    raw_res = _run_raw_dataset_audit(page_items, supp_entries, args.max_signals) if getattr(args, "recompute_raw", False) else None
    code_res = _run_code_supplement_audit(page_items, supp_entries, args.max_signals) if getattr(args, "audit_code", False) else None
    return supp_paths, supp_res, raw_res, code_res


def _write_sarif_out(sarif_path: str | None, payload: dict, artifact_name: str, protected_paths: list[str]) -> None:
    if not sarif_path:
        return
    sarif_mod = importlib.import_module("paper_sarif_export")
    try:
        from build_info import WORKBENCH_VERSION as tool_version
    except Exception:
        tool_version = "0.2.0"
    try:
        sarif_doc = sarif_mod.export_sarif_report(payload, artifact_uri=Path(artifact_name).name, tool_version=tool_version)
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", str(exc), exit_code=3) from None
        raise _CliError("sarif_export_failed", str(exc), exit_code=2) from None
    _write_json_out(sarif_path, sarif_doc, protected_paths)


def _scan_cache_supplements(supp_paths: list[str]) -> list[dict]:
    items = []
    for raw_path in supp_paths:
        p = Path(raw_path)
        items.append({"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
    return items


def _scan_options_dict(args) -> dict:
    return {
        "maxSignals": args.max_signals,
        "digestOnly": bool(args.digest_only),
        "figureForensics": bool(getattr(args, "figure_forensics", False)),
        "flowTriage": bool(getattr(args, "flow_triage", False)),
        "internalConsistency": bool(getattr(args, "internal_consistency", False)),
        "metaTables": bool(getattr(args, "meta_tables", False)),
        "pdfSecurity": bool(getattr(args, "pdf_security", False)),
        "recomputeRaw": bool(getattr(args, "recompute_raw", False)),
        "auditCode": bool(getattr(args, "audit_code", False)),
    }


def _compute_blue_scan_payload(store, pid: str, fhash: str, args, deadline) -> tuple[dict, list[str]]:
    sensor_res = run_blue_sensor(
        pid, file_hash=fhash, max_signals=args.max_signals,
        include_external_oracle=bool(args.oracle),
        include_figure_forensics=bool(getattr(args, "figure_forensics", False)),
        include_flow_triage=bool(getattr(args, "flow_triage", False)),
        include_internal_consistency=bool(getattr(args, "internal_consistency", False)),
        include_meta_and_tables=bool(getattr(args, "meta_tables", False)),
        include_pdf_security=bool(getattr(args, "pdf_security", False)),
        store=store,
    )
    supp_paths, supp_res, raw_res, code_res = _scan_attached_audits(store, pid, fhash, args, deadline)
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
    if raw_res is not None:
        payload["rawDatasetAudit"] = raw_res
    if code_res is not None:
        payload["codeAudit"] = code_res
    if args.digest_only:
        payload = _compact_blue_payload(payload)
    return payload, supp_paths


def _cmd_blue_scan(args, deadline: float | None = None) -> tuple[dict, int]:
    if args.max_signals < 1 or args.max_signals > 100:
        raise _CliError("invalid_arguments", "--max-signals must be between 1 and 100.", exit_code=2)
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    supp_paths = _flatten_paths(args.supplement)
    for sp in supp_paths:
        _require_readable_file(sp, "--supplement")
    _guard_output_paths([args.out, getattr(args, "sarif", None)], [args.pdf, *supp_paths])
    _check_deadline(deadline)
    cache_dir = getattr(args, "cache_dir", None)
    if cache_dir and not args.oracle:
        cache_mod = importlib.import_module("paper_evidence_cache")
        try:
            cache = cache_mod.EvidenceCache(cache_dir)
            key = cache_mod.compute_cache_key(
                "blue-scan", fhash,
                supplements=_scan_cache_supplements(supp_paths),
                options=_scan_options_dict(args),
            )
            cached, hit = cache.get_or_compute(key, lambda: _compute_blue_scan_payload(store, pid, fhash, args, deadline)[0])
        except ValueError as exc:
            raise _CliError("invalid_arguments", f"Cache error: {exc}", exit_code=2) from None
        payload = {**cached, "cacheHit": hit}
    else:
        payload, supp_paths = _compute_blue_scan_payload(store, pid, fhash, args, deadline)
    _write_sarif_out(getattr(args, "sarif", None), payload, args.pdf, [args.pdf, *supp_paths])
    if args.out:
        sarif_extra = [args.sarif] if getattr(args, "sarif", None) else []
        _write_json_out(args.out, payload, [args.pdf, *supp_paths, *sarif_extra])
    return payload, 0


def _cmd_blue_scan_workspace(args, deadline: float | None = None) -> tuple[dict, int]:
    ws_dir = Path(args.workspace).expanduser()
    if not ws_dir.is_dir():
        raise _CliError(
            "file_not_found",
            f"Workspace directory not found: {args.workspace}",
            exit_code=2,
            recovery_hint="Pass an existing readable folder via --workspace.",
        )
    _check_deadline(deadline)
    try:
        ws_mod = importlib.import_module("paper_mcp_workspace")
        triage = ws_mod.triage_workspace(
            ws_dir,
            max_papers=args.max_papers,
            max_signals_per_paper=args.max_signals_per_paper,
            include_figure_forensics=bool(args.figure_forensics),
            recompute_raw=not bool(args.no_recompute_raw),
            include_flow_triage=not bool(getattr(args, "no_flow_triage", False)),
            include_internal_consistency=not bool(getattr(args, "no_internal_consistency", False)),
            cache_dir=getattr(args, "cache_dir", None),
        )
    except ValueError as exc:
        raise _CliError("invalid_arguments", f"Invalid workspace triage arguments: {exc}", exit_code=2) from None
    _check_deadline(deadline)
    payload = {"schema": SCHEMA, "ok": True, "command": "blue scan-workspace", "triage": triage}
    if args.out:
        _write_json_out(args.out, payload, [])
    return payload, 0


def _guard_output_paths(paths: list[str | None], protected_paths: list[str]):
    for out_path in paths:
        if not out_path:
            continue
        target = Path(out_path)
        for src in protected_paths:
            if src and _same_path(target, Path(src)):
                raise _CliError(
                    "cannot_overwrite_input",
                    f"Output path cannot match an input path: {out_path}",
                    exit_code=2,
                    recovery_hint="Write JSON/CSV outputs to paths distinct from --pdf, --report, and --ledger.",
                )


def _cmd_blue_validate(args, deadline: float | None = None) -> tuple[dict, int]:
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    report = _read_json_file(args.report, label="--report")
    ledger = _read_json_file(args.ledger, label="--ledger") if args.ledger else None
    supp_paths = _flatten_paths(getattr(args, "supplement", None))
    supp_entries = [_load_supplement_entry(p) for p in supp_paths]
    protected = [args.pdf, args.report, *supp_paths, *([args.ledger] if args.ledger else [])]
    _guard_output_paths([args.csv, args.out], protected)
    _check_deadline(deadline)
    result = validate_blue_report(
        store.source_bytes(pid, fhash), report,
        ledger=ledger, supplements=supp_entries or None, csv_path=args.csv,
        paper_id=pid, file_hash=fhash,
        include_repair_pack=bool(getattr(args, "emit_repair_pack", False)),
    )
    _check_deadline(deadline)
    missing = result["quoteCheck"]["missingCount"]
    payload = {
        "schema": SCHEMA,
        "ok": missing == 0,
        "command": "blue validate",
        "paperId": result["paperId"],
        "fileHash": result["fileHash"],
        "quoteCheck": result["quoteCheck"],
        "zeroDrop": result["zeroDrop"],
        "csv": result["csv"],
        "warnings": result["warnings"],
    }
    if "repairPack" in result:
        payload["repairPack"] = result["repairPack"]
    exit_code = 0
    if missing:
        payload = {
            **payload,
            "error": "quote_not_found",
            "message": (
                f"{missing} quote(s) missing from the PDF or attached supplements after Zero-Drop restoration."
                if supp_paths else
                f"{missing} quote(s) missing from the PDF after Zero-Drop restoration."
            ),
            "recoveryHint": (
                "Re-read each quoted page, copy the verbatim string into quote/excerpt, "
                "or abstain with verdictLabel 확인필요."
            ),
        }
        exit_code = 3
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, exit_code


def _cmd_blue_finalize(args, deadline: float | None = None) -> tuple[dict, int]:
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    report = _read_json_file(args.report, label="--report")
    repairs = _read_json_file(args.repairs, label="--repairs") if args.repairs else None
    ledger = _read_json_file(args.ledger, label="--ledger") if args.ledger else None
    supp_paths = _flatten_paths(getattr(args, "supplement", None))
    supp_entries = [_load_supplement_entry(p) for p in supp_paths]
    protected = [p for p in [args.pdf, args.report, args.repairs, args.ledger, *supp_paths] if p]
    _guard_output_paths([args.out_report, args.csv, getattr(args, "sarif", None), args.out], protected)
    _check_deadline(deadline)
    result = finalize_blue_report(
        store.source_bytes(pid, fhash),
        report,
        repairs=repairs,
        ledger=ledger,
        supplements=supp_entries or None,
        out_report_path=args.out_report,
        csv_path=args.csv,
        paper_id=pid,
        file_hash=fhash,
        input_paths=protected,
    )
    _check_deadline(deadline)
    payload = {
        "schema": SCHEMA,
        "ok": True,
        "command": "blue finalize",
        "finalizeSchema": result["schema"],
        **{k: v for k, v in result.items() if k not in ("schema", "ok")},
    }
    _write_sarif_out(getattr(args, "sarif", None), result.get("finalizedReport") or payload, args.pdf, protected)
    if args.out:
        extra_out = [p for p in (args.out_report, args.csv, getattr(args, "sarif", None)) if p]
        _write_json_out(args.out, payload, [*protected, *extra_out])
    return payload, 0


def _load_ensemble_reports(report_paths: list[str]) -> list[dict]:
    if len(report_paths) < 2:
        raise _CliError(
            "invalid_arguments",
            "blue ensemble requires at least two --report paths.",
            exit_code=2,
            recovery_hint="Pass --report PATH at least twice.",
        )
    return [_read_json_file(p, label="--report") for p in report_paths]


def _cmd_blue_ensemble(args, deadline: float | None = None) -> tuple[dict, int]:
    report_paths = _flatten_paths(args.report)
    reports = _load_ensemble_reports(report_paths)
    rater_ids = _flatten_paths(getattr(args, "rater_id", None)) or None
    supp_paths = _flatten_paths(getattr(args, "supplement", None))
    supp_entries = [_load_supplement_entry(p) for p in supp_paths] if supp_paths else None
    ledger = _read_json_file(args.ledger, label="--ledger") if getattr(args, "ledger", None) else None
    pdf_bytes = _require_pdf_bytes(args.pdf)[1] if getattr(args, "pdf", None) else None
    protected = [p for p in [*report_paths, getattr(args, "pdf", None), getattr(args, "ledger", None), *supp_paths] if p]
    _guard_output_paths([args.csv, getattr(args, "sarif", None), args.out], protected)
    _check_deadline(deadline)
    ens_mod = importlib.import_module("blue_ensemble")
    try:
        res = ens_mod.ensemble_blue_reports(
            reports,
            rater_ids=rater_ids,
            pdf_bytes=pdf_bytes,
            supplements=supp_entries,
            ledger_candidates=ledger,
            min_consensus=getattr(args, "min_consensus", None),
        )
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", f"BLUE ensemble rejected report: {exc}", exit_code=3) from None
        raise _CliError("invalid_arguments", f"BLUE ensemble failed: {exc}", exit_code=2) from None
    if args.csv and isinstance(res.get("csvText"), str):
        csv_target = Path(args.csv)
        csv_target.parent.mkdir(parents=True, exist_ok=True)
        csv_target.write_text(res["csvText"], encoding="utf-8")
    _write_sarif_out(
        getattr(args, "sarif", None),
        res.get("finalReport") or {"findings": res.get("findings", [])},
        args.pdf or "manuscript.pdf",
        protected,
    )
    payload = {"schema": SCHEMA, "ok": True, "command": "blue ensemble", "ensemble": res}
    if args.out:
        extra_out = [p for p in (args.csv, getattr(args, "sarif", None)) if p]
        _write_json_out(args.out, payload, [*protected, *extra_out])
    return payload, 0


def _require_readable_file(path_str: str, label: str) -> Path:
    path = Path(path_str)
    if not path.is_file():
        raise _CliError(
            "file_not_found",
            f"{label} file not found: {path_str}",
            exit_code=2,
            recovery_hint=f"Verify the {label} path exists and is readable.",
        )
    return path.resolve()


def _paper_mcp_script() -> Path:
    script = _HERE.parent / "paper_mcp.py"
    if not script.is_file():
        raise _CliError(
            "paper_mcp_missing",
            f"paper_mcp.py not found next to the CLI: {script}",
            exit_code=2,
            recovery_hint="Run the CLI from a complete app/local installation.",
        )
    return script


def _paper_mcp_accepts_workspace() -> bool:
    factory = getattr(paper_mcp, "_parser", None)
    if factory is None:
        return False
    try:
        parser = factory()
    except Exception:
        return False
    return any("--workspace" in action.option_strings for action in parser._actions)


def _mcp_config_argv(args) -> list[str]:
    argv = [str(_paper_mcp_script())]
    if args.pdf:
        argv.extend(["--pdf", str(_require_readable_file(args.pdf, "--pdf"))])
    if args.analysis:
        argv.append("--analysis")
    for supp in _flatten_paths(args.supplement):
        argv.extend(["--supplement", str(_require_readable_file(supp, "--supplement"))])
    if args.workspace:
        argv.extend(["--workspace", str(Path(args.workspace).expanduser().resolve())])
    if args.oracle:
        argv.append("--oracle")
    return argv


def _shell_quote(value: str) -> str:
    text = str(value)
    return f'"{text}"' if any(ch in text for ch in ' \t"') else text


def _mcp_usage(command: str, args: list[str], server_key: str = MCP_SERVER_KEY) -> dict:
    invocation = " ".join(_shell_quote(part) for part in [command, *args])
    codex_args = ", ".join(json.dumps(str(part), ensure_ascii=False) for part in args)
    gemini = {"mcpServers": {server_key: {"command": command, "args": args}}}
    return {
        "claude": f"claude mcp add {server_key} -- {invocation}",
        "codex": (
            f"[mcp_servers.{server_key}]\n"
            f"command = {json.dumps(command, ensure_ascii=False)}\n"
            f"args = [{codex_args}]"
        ),
        "gemini": json.dumps(gemini, ensure_ascii=False, indent=2),
    }


def _paper_red_script() -> Path:
    script = _HERE.parent / "paper_red_mcp.py"
    if not script.is_file():
        raise _CliError(
            "paper_red_mcp_missing",
            f"paper_red_mcp.py not found next to the CLI: {script}",
            exit_code=2,
            recovery_hint="Run the CLI from a complete app/local installation.",
        )
    return script


def _reject_mcp_selection(args) -> None:
    has_pdf = bool(getattr(args, "pdf", None))
    has_ws = bool(getattr(args, "workspace", None))
    role = getattr(args, "role", None) or "blue"
    if not has_pdf and not has_ws:
        raise _CliError(
            "invalid_arguments",
            "Specify exactly one of --pdf or --workspace.",
            exit_code=2,
            recovery_hint="Pass --pdf for one paper or --workspace for a read-only PDF directory.",
        )
    if has_ws and not Path(args.workspace).expanduser().is_dir():
        raise _CliError(
            "file_not_found",
            f"Workspace directory not found: {args.workspace}",
            exit_code=2,
            recovery_hint="Create the workspace directory or pass an existing folder.",
        )
    if role == "red" and has_ws:
        raise _CliError(
            "invalid_arguments",
            "RED MCP server (paper_red_mcp.py) requires --pdf and does not support --workspace.",
            exit_code=2,
            recovery_hint="Pass --pdf alone with --role red.",
        )


def _usage_for_servers(command: str, servers: dict) -> dict:
    if len(servers) == 1:
        name, spec = next(iter(servers.items()))
        return _mcp_usage(command, spec["args"], name)
    blocks = [(name, _mcp_usage(command, spec["args"], name)) for name, spec in servers.items()]
    gemini = {
        "mcpServers": {
            name: {"command": command, "args": spec["args"]} for name, spec in servers.items()
        },
    }
    return {
        "claude": "\n".join(block["claude"] for _name, block in blocks),
        "codex": "\n\n".join(block["codex"] for _name, block in blocks),
        "gemini": json.dumps(gemini, ensure_ascii=False, indent=2),
    }


def _mcp_red_argv(args) -> list[str]:
    argv = [str(_paper_red_script()), "--pdf", str(_require_readable_file(args.pdf, "--pdf"))]
    for supp in _flatten_paths(args.supplement):
        argv.extend(["--supplement", str(_require_readable_file(supp, "--supplement"))])
    return argv


def _mcp_servers(args, python_exe: str) -> tuple[dict, list[str]]:
    role = getattr(args, "role", None) or "blue"
    warnings: list[str] = []
    servers: dict = {}
    if role in ("blue", "both"):
        servers[MCP_SERVER_KEY] = {"command": python_exe, "args": _mcp_config_argv(args)}
        if args.workspace and not _paper_mcp_accepts_workspace():
            warnings.append(MCP_WORKSPACE_WARNING)
    if role == "both" and args.workspace and not args.pdf:
        warnings.append("falsify-paper-red skipped because --workspace mode is read-only BLUE only")
    if role in ("red", "both") and args.pdf:
        servers[RED_MCP_SERVER_KEY] = {"command": python_exe, "args": _mcp_red_argv(args)}
    return servers, warnings


def _cmd_mcp_config(args, deadline: float | None = None) -> tuple[dict, int]:
    _check_deadline(deadline)
    _reject_mcp_selection(args)
    python_exe = sys.executable or "python"
    servers, warnings = _mcp_servers(args, python_exe)
    payload = {
        "schema": MCP_CONFIG_SCHEMA,
        "ok": True,
        "command": "mcp-config",
        "servers": servers,
        "registers": list(MCP_REGISTERS),
        "usage": _usage_for_servers(python_exe, servers),
        "warnings": warnings,
    }
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


def _supplements_for_detectability(entries: list[dict] | None):
    if not entries:
        return None
    prepared = []
    for entry in entries:
        text = entry.get("text")
        if not isinstance(text, str):
            pages = entry.get("pages")
            text = "\n".join(str(page) for page in pages) if isinstance(pages, list) else ""
        cleaned = {k: v for k, v in entry.items() if k != "bytes"}
        name_low = str(entry.get("name") or "").lower()
        if isinstance(entry.get("bytes"), (bytes, bytearray)) and name_low.endswith((".xlsx", ".ipynb")):
            cleaned["rawBytes"] = bytes(entry["bytes"])
        prepared.append({**cleaned, "text": text})
    return prepared


def _load_optional_supplements(groups) -> tuple[list[str], list[dict] | None]:
    paths = _flatten_paths(groups)
    if not paths:
        return paths, None
    return paths, _supplements_for_detectability([_load_supplement_entry(path) for path in paths])


def _detectability_operations(sim_res: dict) -> list:
    operations = sim_res.get("operations")
    if isinstance(operations, list):
        return operations
    results = sim_res.get("results")
    return results if isinstance(results, list) else []


def _operation_distance(op: dict) -> str:
    for key in ("crossInferenceDistance", "difficulty", "distance"):
        value = op.get(key)
        if value in _DIFFICULTY_RANK:
            return value
    return ""


def _below_minimum_ops(sim_res: dict, minimum: str) -> list[dict]:
    floor = _DIFFICULTY_RANK[minimum]
    failing = []
    for op in _detectability_operations(sim_res):
        rank = _DIFFICULTY_RANK.get(_operation_distance(op))
        if rank is not None and rank < floor:
            failing.append(op)
    return failing


def _simulate_for_gate(args, store, pid, fhash, resolved_ops, supp_entries):
    minimum = getattr(args, "min_difficulty", None)
    if not minimum:
        return None
    try:
        sim_res = paper_red_detectability.simulate_red_detectability(
            pid, resolved_ops, file_hash=fhash, store=store,
            supplements=supp_entries, max_signals=50,
        )
    except ValueError as exc:
        raise _CliError(
            "red_apply_failed",
            f"Detectability simulation failed: {exc}",
            exit_code=2,
            recovery_hint="Check operation ids, supplement text, and --min-difficulty.",
        ) from None
    failing = _below_minimum_ops(sim_res, minimum)
    if failing:
        raise _CliError(
            "difficulty_below_minimum",
            f"{len(failing)} operation(s) are below minimum difficulty {minimum}.",
            exit_code=3,
            recovery_hint="Raise the operation difficulty or lower --min-difficulty before writing the blind PDF.",
            extra={"minDifficulty": minimum, "belowMinimum": failing, "detectability": sim_res},
        )
    return sim_res


def _require_signal_limit(value: int, flag: str) -> None:
    if type(value) is not int or not 1 <= value <= 100:
        raise _CliError("invalid_arguments", f"{flag} must be between 1 and 100.", exit_code=2)


def _cmd_red_simulate(args, deadline: float | None = None) -> tuple[dict, int]:
    _require_signal_limit(args.max_signals, "--max-signals")
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    resolved_ops = _resolve_table_item_ids(store, pid, _load_ops_payload(args.ops))
    supp_paths, supp_entries = _load_optional_supplements(args.supplement)
    _check_deadline(deadline)
    try:
        res = paper_red_detectability.simulate_red_detectability(
            pid, resolved_ops, file_hash=fhash, store=store,
            supplements=supp_entries, max_signals=args.max_signals,
        )
    except ValueError as exc:
        raise _CliError("red_simulate_failed", f"Detectability simulation failed: {exc}", exit_code=2) from None
    payload = {"schema": SCHEMA, "ok": True, "command": "red simulate", "detectability": res}
    if args.out:
        _write_json_out(args.out, payload, [args.pdf, *supp_paths])
    return payload, 0


def _cmd_red_trace(args, deadline: float | None = None) -> tuple[dict, int]:
    _require_signal_limit(args.max_occurrences, "--max-occurrences")
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    supp_paths, supp_entries = _load_optional_supplements(args.supplement)
    _check_deadline(deadline)
    try:
        res = paper_red_detectability.trace_claim_propagation(
            pid, args.claim, file_hash=fhash, store=store,
            supplements=supp_entries, max_occurrences=args.max_occurrences,
        )
    except ValueError as exc:
        raise _CliError("red_trace_failed", f"Claim trace failed: {exc}", exit_code=2) from None
    payload = {"schema": SCHEMA, "ok": True, "command": "red trace", "propagation": res}
    if args.out:
        _write_json_out(args.out, payload, [args.pdf, *supp_paths])
    return payload, 0


def _load_optional_json_dict(raw_arg: str | None, label: str) -> tuple[dict | None, list[str]]:
    if not raw_arg:
        return None, []
    stripped = str(raw_arg).strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise _CliError("invalid_json", f"Invalid {label} JSON: {exc}", exit_code=2) from None
        paths: list[str] = []
    else:
        parsed = _read_json_file(raw_arg, label=label)
        paths = [raw_arg]
    if not isinstance(parsed, dict):
        raise _CliError("invalid_arguments", f"{label} must decode to a JSON object.", exit_code=2)
    red_keys = _find_red_keys(parsed)
    if red_keys:
        raise _CliError(
            "forbidden_red_key",
            f"{label} contains forbidden RED/gold key(s): {', '.join(red_keys[:5])}",
            exit_code=3,
            recovery_hint="Pass an answer-key-free redBrief object without gold/before/after/patch fields.",
        )
    return parsed, paths


def _cmd_red_plan(args, deadline: float | None = None) -> tuple[dict, int]:
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    supp_paths, supp_entries = _load_optional_supplements(args.supplement)
    brief_doc, brief_paths = _load_optional_json_dict(getattr(args, "red_brief", None), "--red-brief")
    _check_deadline(deadline)
    try:
        planner = importlib.import_module("paper_red_planner")
        res = planner.plan_coordinated_mutations(
            pid,
            file_hash=fhash,
            store=store,
            supplements=supp_entries,
            service=ChartEditService(store),
            target_difficulty=args.target_difficulty,
            max_bundles=args.max_bundles,
            claim_query=args.claim,
            red_brief=brief_doc,
        )
    except ValueError as exc:
        if "forbidden_red_key" in str(exc):
            raise _CliError("forbidden_red_key", f"RED mutation planner rejected brief: {exc}", exit_code=3) from None
        code = "invalid_arguments" if str(exc) in ("target_difficulty_invalid", "limit", "red_brief_invalid") else "red_plan_failed"
        raise _CliError(code, f"RED mutation planner failed: {exc}", exit_code=2) from None
    _check_deadline(deadline)
    payload = {"schema": SCHEMA, "ok": True, "command": "red plan", "plan": res}
    if args.out:
        _write_json_out(args.out, payload, [args.pdf, *supp_paths, *brief_paths])
    return payload, 0


def _validate_red_apply_paths(args, src_path: Path, out_pdf: Path):
    if _same_path(src_path, out_pdf):
        raise _CliError(
            "cannot_overwrite_source",
            "--out-pdf must not resolve to the source --pdf path.",
            exit_code=2,
            recovery_hint="Write the blind PDF to a separate output path.",
        )
    if args.out_gold and (_same_path(src_path, Path(args.out_gold)) or _same_path(out_pdf, Path(args.out_gold))):
        raise _CliError("cannot_overwrite_input", "--out-gold must be distinct from --pdf and --out-pdf.", exit_code=2)
    out_supp_dir = getattr(args, "out_supplement_dir", None)
    if out_supp_dir:
        dest_dir = Path(out_supp_dir)
        for supp in _flatten_paths(getattr(args, "supplement", None)):
            if _same_path(dest_dir / Path(supp).name, Path(supp)):
                raise _CliError(
                    "cannot_overwrite_source",
                    f"--out-supplement-dir would overwrite input supplement: {supp}",
                    exit_code=2,
                    recovery_hint="Pass a separate output directory for --out-supplement-dir.",
                )


def _normalize_red_supplements(supp_entries: list[dict] | None) -> list[dict] | None:
    if not supp_entries:
        return None
    mutator = importlib.import_module("paper_supplement_mutator")
    return mutator.normalize_red_supplements_extended(supp_entries)


def _blind_supp_bytes(rec: dict) -> bytes:
    encoded = rec.get("contentBase64")
    if isinstance(encoded, str) and encoded:
        return base64.b64decode(encoded)
    return str(rec.get("text") or "").encode("utf-8")


def _write_blind_supplements(out_dir_str: str | None, blind_supps: list[dict], protected: list[str]) -> list[str]:
    if not out_dir_str:
        return []
    out_dir = Path(out_dir_str)
    targets = [(rec, out_dir / Path(rec["name"]).name) for rec in blind_supps]
    for _rec, dest in targets:
        for src in protected:
            if src and _same_path(dest, Path(src)):
                raise _CliError(
                    "cannot_overwrite_source",
                    f"--out-supplement-dir would overwrite input/output file: {dest}",
                    exit_code=2,
                    recovery_hint="Pass a separate output directory for --out-supplement-dir.",
                )
    mutator = importlib.import_module("paper_text_span_mutator")
    mutator.assert_blind_supplements(blind_supps)
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for rec, dest in targets:
        dest.write_bytes(_blind_supp_bytes(rec))
        written.append(str(dest))
    return written


def _apply_non_text_ops(store, pid: str, fhash: str, other_ops: list[dict], norm_supps: list[dict] | None):
    try:
        applied = paper_red_mcp._apply_operations(
            store, ChartEditService(store), pid, fhash, other_ops, supplements=norm_supps,
        )
        return applied[0], applied[1], applied[2], list(applied[3] if len(applied) > 3 else [])
    except ValueError as exc:
        details = getattr(exc, "details", None)
        if isinstance(details, dict):
            raise _CliError(
                getattr(exc, "code", "red_apply_failed"),
                str(exc),
                exit_code=2,
                recovery_hint=str(details.get("recoveryHint") or "Verify supplement/target exact text."),
                extra={"nearestCandidates": list(details.get("nearestCandidates") or [])},
            ) from None
        raise _CliError(
            "red_apply_failed",
            f"Operation application failed: {exc}",
            exit_code=2,
            recovery_hint="Verify target IDs, rows/columns, before text, and URIs using 'red targets'.",
        ) from None


def _cmd_red_apply(args, deadline: float | None = None) -> tuple[dict, int]:
    src_path, _ = _require_pdf_bytes(args.pdf)
    out_pdf = Path(args.out_pdf)
    _validate_red_apply_paths(args, src_path, out_pdf)
    ops = _load_ops_payload(args.ops)
    store, summary = _open_pdf_store(args.pdf)
    pid, fhash = summary["paperId"], summary["fileHash"]
    _check_deadline(deadline)
    resolved_ops = _resolve_table_item_ids(store, pid, ops)
    supp_paths, supp_entries = _load_optional_supplements(getattr(args, "supplement", None))
    norm_supps = _normalize_red_supplements(supp_entries)
    sim_res = _simulate_for_gate(args, store, pid, fhash, resolved_ops, supp_entries)
    text_ops = [op for op in resolved_ops if op.get("kind") == "text-span"]
    other_ops = [op for op in resolved_ops if op.get("kind") != "text-span"]
    src_bytes, edited_bytes, vis_result, blind_supps = _apply_non_text_ops(store, pid, fhash, other_ops, norm_supps)
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
    protected = [args.pdf, str(out_pdf), *supp_paths, *([args.out_gold] if args.out_gold else [])]
    out_supp_files = _write_blind_supplements(getattr(args, "out_supplement_dir", None), blind_supps, protected)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    out_pdf.write_bytes(edited_bytes)
    out_sha = hashlib.sha256(edited_bytes).hexdigest()
    all_changes = _enrich_gold_changes(ops, list(vis_result.get("changes") or []) + text_changes, stealth)
    ledger = None
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
    payload = {
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
    }
    if getattr(args, "out_supplement_dir", None):
        payload["outSupplementDir"] = str(Path(args.out_supplement_dir))
        payload["outSupplements"] = out_supp_files
    if sim_res is not None:
        payload["detectability"] = sim_res
        if ledger is not None:
            payload["goldLedger"] = ledger
    return payload, 0


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


def _extract_xlsx_xml_corpus(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            parts = [
                zf.read(m).decode("utf-8", errors="replace")
                for m in sorted(zf.namelist())
                if m.lower().endswith((".xml", ".rels")) and zf.getinfo(m).file_size <= 8 * 1024 * 1024
            ]
            return "\n".join(parts)
    except (zipfile.BadZipFile, OSError, KeyError):
        raise _CliError("invalid_supplement", "Supplement .xlsx is not a valid ZIP/XLSX archive.", exit_code=2) from None


def _inspect_one_supp_blindness(path: Path, ext: str, raw: bytes) -> list[dict]:
    leaks = []
    if ext in (".json", ".ipynb"):
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
    elif ext == ".xlsx":
        text = _extract_xlsx_xml_corpus(raw)
    else:
        text = raw.decode("utf-8-sig", errors="replace")
    for item in _scan_text_patterns(text, f"supplement:{path.name}"):
        leaks.append({**item, "file": path.name})
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
        leaks.extend(_inspect_one_supp_blindness(path, ext, path.read_bytes()))
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
            items.append({"name": path.name, "text": "\n".join(_extract_pdf_pages(raw))})
        elif ext == ".docx":
            items.append({"name": path.name, "text": _extract_docx_text(raw)})
        elif ext == ".xlsx":
            items.append({"name": path.name, "text": _extract_xlsx_xml_corpus(raw), "bytes": raw})
        else:
            items.append({"name": path.name, "text": raw.decode("utf-8-sig", errors="replace")})
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
        for key in ("supplementAudit", "rawDatasetAudit", "codeAudit"):
            sub = blue_raw.get(key)
            if isinstance(sub, dict):
                items.extend(sub.get("signals") or [])
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


def _arena_round_module():
    try:
        return importlib.import_module("arena_round")
    except ImportError:
        raise _CliError(
            "arena_round_unavailable",
            "tools/evaluation/arena_round.py is missing from this installation.",
            exit_code=2,
            recovery_hint="Run the CLI from a complete repository checkout.",
        ) from None


def _arena_round_cli_error(exc) -> _CliError:
    code = str(getattr(exc, "code", "input_invalid"))
    hints = {
        "blindness_leak_detected": "Re-export the blind bundle; the cleanroom is never created while leaks remain.",
        "timeout": "Increase --agent-timeout or shorten the agent command's work.",
        "agent_argv_invalid": "Pass a real executable with --agent-cmd and plain --agent-arg values.",
        "agent_required": "Pass --agent-cmd EXE so the round has a BLUE agent to run.",
        "env_allow_unsupported": "The default adapter keeps harness_adapter's fixed minimal environment.",
        "gold_ledger_invalid": "Fix the --gold JSON so it is a falsify.red-gold-ledger.v1 object.",
    }
    return _CliError(
        code,
        f"arena round rejected the request: {code}",
        exit_code=getattr(exc, "exit_code", 2),
        recovery_hint=hints.get(code, "Inspect the agent command, the blind bundle, and the gold ledger JSON."),
    )


def _arena_round_supplements(supp_paths: list[str]) -> list[dict]:
    supplements = []
    for supp in supp_paths:
        path = Path(supp)
        if not path.is_file():
            raise _CliError("file_not_found", f"Missing --supplement file: {supp}", exit_code=2)
        supplements.append({"name": path.name, "bytes": path.read_bytes()})
    return supplements


def _arena_round_exit(payload: dict) -> int:
    if payload.get("ok"):
        return 0
    error = payload.get("error")
    if error in ("blindness_leak_detected", "distill_scrub_failed"):
        return 3
    return 124 if error == "timeout" else 2


def _cmd_arena_run_round(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _arena_round_module()
    pdf_path, pdf_bytes = _require_pdf_bytes(args.pdf)
    source_bytes = _require_pdf_bytes(args.source_pdf)[1] if args.source_pdf else None
    supp_paths = _flatten_paths(args.supplement)
    agent_argv = [args.agent_cmd, *_flatten_paths(args.agent_arg)]
    gold = _read_json_file(args.gold, label="--gold") if args.gold else None
    baseline = _read_json_file(args.baseline, label="--baseline") if args.baseline else None
    _check_deadline(deadline)
    try:
        record = module.run_round(
            pdf_bytes,
            agent_argv,
            gold_ledger=gold,
            blind_supplements=_arena_round_supplements(supp_paths) or None,
            source_pdf_bytes=source_bytes,
            runs=args.runs,
            timeout=args.agent_timeout,
            baseline_signals=baseline,
        )
    except module.ArenaRoundError as exc:
        raise _arena_round_cli_error(exc) from None
    _check_deadline(deadline)
    payload = {
        "schema": SCHEMA,
        "ok": bool(record.get("ok", True)),
        "command": "arena run-round",
        "round": record,
    }
    if record.get("error"):
        payload["error"] = record["error"]
    protected = [args.pdf, *([args.source_pdf] if args.source_pdf else []), *supp_paths]
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, _arena_round_exit(payload)


def _cmd_arena_distill(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _arena_round_module()
    round_record = _read_json_file(args.round, label="--round")
    gold = _read_json_file(args.gold, label="--gold") if args.gold else None
    _check_deadline(deadline)
    try:
        patch = module.distill_round(round_record, gold_ledger=gold, max_rules=args.max_rules)
    except module.DistillScrubError as exc:
        raise _CliError(
            "distill_scrub_failed",
            f"{len(getattr(exc, 'hits', []))} answer-key pattern(s) survived distillation.",
            exit_code=3,
            recovery_hint="Distill aggregate counts only; remove item text, ids, values and answer-key words.",
        ) from None
    except module.ArenaRoundError as exc:
        raise _arena_round_cli_error(exc) from None
    payload = {"schema": SCHEMA, "ok": True, "command": "arena distill", "harnessPatch": patch}
    protected = [args.round, *([args.gold] if args.gold else [])]
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, 0


def _arena_duel_module():
    try:
        return importlib.import_module("arena_duel")
    except ImportError:
        raise _CliError(
            "arena_duel_unavailable",
            "tools/evaluation/arena_duel.py is missing from this installation.",
            exit_code=2,
            recovery_hint="Run the CLI from a complete repository checkout.",
        ) from None


def _benchmark_suite_module():
    try:
        return importlib.import_module("benchmark_suite")
    except ImportError:
        raise _CliError(
            "benchmark_suite_unavailable",
            "tools/evaluation/benchmark_suite.py is missing from this installation.",
            exit_code=2,
            recovery_hint="Run the CLI from a complete repository checkout.",
        ) from None


def _arena_duel_cli_error(exc, label: str) -> _CliError:
    code = str(getattr(exc, "code", "input_invalid"))
    return _CliError(
        code,
        f"arena {label} rejected the request: {code}",
        exit_code=getattr(exc, "exit_code", 2),
        recovery_hint="Inspect agent commands, difficulty/blindness gates, generation cap, and holdout FP guard.",
        extra=dict(getattr(exc, "extra", None) or {}),
    )


def _cmd_arena_duel(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _arena_duel_module()
    _src_path, source_bytes = _require_pdf_bytes(args.source_pdf)
    supp_paths = _flatten_paths(args.supplement)
    holdout_paths = _flatten_paths(args.holdout_pdf)
    red_argv = [args.red_cmd, *_flatten_paths(args.red_arg)]
    blue_argv = [args.blue_cmd, *_flatten_paths(args.blue_arg)]
    red_harness = _read_json_file(args.red_harness, label="--red-harness") if getattr(args, "red_harness", None) else None
    blue_harness = _read_json_file(args.blue_harness, label="--blue-harness") if getattr(args, "blue_harness", None) else None
    _check_deadline(deadline)
    try:
        duel = module.run_duel(
            source_bytes,
            red_argv=red_argv,
            blue_argv=blue_argv,
            supplements=_arena_round_supplements(supp_paths) or None,
            holdout_pdfs=_arena_round_supplements(holdout_paths) or None,
            min_difficulty=args.min_difficulty,
            runs=args.runs,
            timeout=args.agent_timeout,
            validate_quotes=not bool(args.no_validate_quotes),
            max_rules=args.max_rules,
            red_harness=red_harness,
            blue_harness=blue_harness,
        )
    except module.ArenaDuelError as exc:
        raise _arena_duel_cli_error(exc, "duel") from None
    _check_deadline(deadline)
    payload = {"schema": SCHEMA, "ok": True, "command": "arena duel", "duel": duel}
    harness_paths = [p for p in (getattr(args, "red_harness", None), getattr(args, "blue_harness", None)) if p]
    protected = [args.source_pdf, *supp_paths, *holdout_paths, *harness_paths]
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, 0


def _cmd_arena_apply_patch(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _arena_duel_module()
    harness_doc = _read_json_file(args.harness, label="--harness")
    patch_doc = _read_json_file(args.patch, label="--patch")
    _check_deadline(deadline)
    try:
        promotion = module.apply_harness_patch(
            harness_doc,
            patch_doc,
            role=args.role,
            max_generations=args.max_generations,
            baseline_holdout_fp=args.baseline_holdout_fp,
            candidate_holdout_fp=args.candidate_holdout_fp,
            max_instructions_chars=args.max_instructions_chars,
            compact_rules=bool(getattr(args, "compact_rules", False)),
        )
    except module.ArenaDuelError as exc:
        raise _arena_duel_cli_error(exc, "apply-patch") from None
    payload = {"schema": SCHEMA, "ok": True, "command": "arena apply-patch", "promotion": promotion}
    if args.out:
        _write_json_out(args.out, payload, [args.harness, args.patch])
    return payload, 0


def _arena_campaign_module():
    try:
        return importlib.import_module("arena_campaign")
    except ImportError:
        raise _CliError(
            "arena_campaign_unavailable",
            "tools/evaluation/arena_campaign.py is missing from this installation.",
            exit_code=2,
            recovery_hint="Run the CLI from a complete repository checkout.",
        ) from None


def _evolve_sources(source_paths: list[str], supp_entries: list[dict]) -> list[dict]:
    sources = []
    for path_str in source_paths:
        src_path, src_bytes = _require_pdf_bytes(path_str)
        sources.append({"name": src_path.name, "bytes": src_bytes, "supplements": list(supp_entries)})
    return sources


def _write_evolve_outputs(args, payload: dict, lineage: dict, protected: list[str]) -> None:
    if args.out_harness:
        _write_json_out(args.out_harness, lineage["finalHarness"], protected)
    out_red = getattr(args, "out_red_harness", None)
    if out_red and isinstance(lineage.get("finalRedHarness"), dict):
        extra_red = [args.out_harness] if args.out_harness else []
        _write_json_out(out_red, lineage["finalRedHarness"], [*protected, *extra_red])
    if args.out:
        extra = [p for p in (args.out_harness, out_red) if p]
        _write_json_out(args.out, payload, [*protected, *extra])


def _cmd_arena_evolve(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _arena_campaign_module()
    src_paths = _flatten_paths(args.source_pdf)
    supp_paths = _flatten_paths(args.supplement)
    holdout_paths = _flatten_paths(args.holdout_pdf)
    sources = _evolve_sources(src_paths, _arena_round_supplements(supp_paths))
    default_role = "blue" if args.role == "both" else args.role
    base_harness = (
        _read_json_file(args.harness, label="--harness")
        if args.harness else module._default_harness(default_role)
    )
    red_harness_arg = getattr(args, "red_harness", None)
    base_red_harness = _read_json_file(red_harness_arg, label="--red-harness") if red_harness_arg else None
    input_harnesses = [p for p in (args.harness, red_harness_arg) if p]
    protected = [*src_paths, *supp_paths, *holdout_paths, *input_harnesses]
    _guard_output_paths([args.out, args.out_harness, getattr(args, "out_red_harness", None)], protected)
    _check_deadline(deadline)
    try:
        lineage = module.run_evolution_campaign(
            sources,
            base_harness=base_harness,
            red_argv=[args.red_cmd, *_flatten_paths(args.red_arg)],
            blue_argv=[args.blue_cmd, *_flatten_paths(args.blue_arg)],
            holdout_pdfs=_arena_round_supplements(holdout_paths) or None,
            generations=args.generations,
            role=args.role,
            min_difficulty=args.min_difficulty,
            runs=args.runs,
            timeout=args.agent_timeout,
            max_rules=args.max_rules,
            max_instructions_chars=args.max_instructions_chars,
            max_recall_drop=args.max_recall_drop,
            base_red_harness=base_red_harness,
            compact_rules=bool(getattr(args, "compact_rules", False)),
            checkpoint_dir=getattr(args, "checkpoint_dir", None),
            resume=bool(getattr(args, "resume", False)),
            max_total_seconds=getattr(args, "max_total_seconds", None),
        )
    except module.ArenaCampaignError as exc:
        raise _arena_duel_cli_error(exc, "evolve") from None
    _check_deadline(deadline)
    payload = {"schema": SCHEMA, "ok": True, "command": "arena evolve", "lineage": lineage}
    _write_evolve_outputs(args, payload, lineage, protected)
    return payload, 0


def _parse_tournament_entries(raw_specs: list[str], label: str) -> tuple[list[dict], list[str]]:
    entries, file_paths = [], []
    for raw in raw_specs:
        doc, paths = _load_optional_json_dict(raw, label)
        if doc is None:
            raise _CliError("invalid_arguments", f"{label} cannot be empty.", exit_code=2)
        entries.append(doc)
        file_paths.extend(paths)
    return entries, file_paths


def _cmd_arena_tournament(args, deadline: float | None = None) -> tuple[dict, int]:
    src_paths = _flatten_paths(args.source_pdf)
    for sp in src_paths:
        _require_pdf_bytes(sp)
    supp_paths = _flatten_paths(getattr(args, "supplement", None))
    holdout_paths = _flatten_paths(getattr(args, "holdout_pdf", None))
    red_entries, red_files = _parse_tournament_entries(_flatten_paths(args.red_entry), "--red-entry")
    blue_entries, blue_files = _parse_tournament_entries(_flatten_paths(args.blue_entry), "--blue-entry")
    protected = [*src_paths, *supp_paths, *holdout_paths, *red_files, *blue_files]
    _guard_output_paths([args.out], protected)
    _check_deadline(deadline)
    t_mod = importlib.import_module("arena_tournament")
    try:
        report = t_mod.run_arena_tournament(
            source_pdfs=src_paths,
            red_entries=red_entries,
            blue_entries=blue_entries,
            supplements=supp_paths or None,
            holdout_pdfs=holdout_paths or None,
            min_difficulty=args.min_difficulty,
            agent_timeout=args.agent_timeout,
            validate_quotes=not bool(args.no_validate_quotes),
        )
    except ValueError as exc:
        code = "tournament_scrub_failed" if "scrub" in str(exc) else "invalid_arguments"
        exit_c = 3 if code == "tournament_scrub_failed" else 2
        raise _CliError(code, f"Arena tournament failed: {exc}", exit_code=exit_c) from None
    _check_deadline(deadline)
    payload = {"schema": SCHEMA, "ok": True, "command": "arena tournament", "tournament": report}
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, 0


def _cmd_schemas(args, deadline: float | None = None) -> tuple[dict, int]:
    _check_deadline(deadline)
    sarif_mod = importlib.import_module("paper_sarif_export")
    try:
        catalog = sarif_mod.list_falsify_schemas(getattr(args, "id", None))
    except ValueError as exc:
        raise _CliError(
            "schema_id_unknown",
            f"Unknown schema id: {getattr(args, 'id', None)} ({exc})",
            exit_code=2,
            recovery_hint="Run 'falsify schemas' without --id to list all registered schemaIds.",
        ) from None
    payload = {"schema": SCHEMA, "ok": True, "command": "schemas", "catalog": catalog}
    if getattr(args, "out", None):
        _write_json_out(args.out, payload, [])
    return payload, 0


def _benchmark_agent_argv(args) -> list[str] | None:
    if args.mode != "agent":
        return None
    if not args.agent_cmd:
        raise _CliError(
            "invalid_arguments",
            "--agent-cmd is required when --mode agent.",
            exit_code=2,
            recovery_hint="Pass --agent-cmd EXE or use --mode sensor.",
        )
    return [args.agent_cmd, *_flatten_paths(args.agent_arg)]


def _cmd_arena_benchmark(args, deadline: float | None = None) -> tuple[dict, int]:
    module = _benchmark_suite_module()
    agent_argv = _benchmark_agent_argv(args)
    baseline = _read_json_file(args.baseline_report, label="--baseline-report") if args.baseline_report else None
    case_ids = _flatten_paths(args.case) or None
    _check_deadline(deadline)
    try:
        report = module.run_benchmark_suite(
            mode=args.mode,
            case_ids=case_ids,
            agent_argv=agent_argv,
            baseline_report=baseline,
            max_recall_drop=args.max_recall_drop,
            allow_holdout_fp_increase=bool(args.allow_holdout_fp_increase),
        )
    except ValueError as exc:
        raise _CliError("invalid_arguments", f"Invalid benchmark arguments: {exc}", exit_code=2) from None
    _check_deadline(deadline)
    comparison = report.get("comparison")
    regressed = isinstance(comparison, dict) and comparison.get("passed") is False
    payload = {"schema": SCHEMA, "ok": not regressed, "command": "arena benchmark", "benchmark": report}
    if regressed:
        payload["error"] = "benchmark_regression_detected"
        payload["message"] = "Benchmark comparison failed recall or holdout pure-FP gate."
        payload["recoveryHint"] = "Inspect benchmark.comparison.regressions before promoting changes."
    protected = [args.baseline_report] if args.baseline_report else []
    if args.out:
        _write_json_out(args.out, payload, protected)
    return payload, (3 if regressed else 0)


def _add_blue_parser(subparsers, parent):
    blue = subparsers.add_parser("blue", parents=[parent], help="BLUE verification commands")
    blue_sub = blue.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    scan = blue_sub.add_parser("scan", parents=[parent], help="Run Layer 0 BLUE sensor + optional supplement audit")
    scan.add_argument("--pdf", required=True)
    scan.add_argument("--supplement", action="append", nargs="+")
    scan.add_argument("--oracle", action="store_true")
    scan.add_argument("--figure-forensics", action="store_true")
    scan.add_argument("--flow-triage", action="store_true")
    scan.add_argument("--internal-consistency", action="store_true")
    scan.add_argument("--meta-tables", action="store_true")
    scan.add_argument("--pdf-security", action="store_true")
    scan.add_argument("--recompute-raw", action="store_true")
    scan.add_argument("--audit-code", action="store_true")
    scan.add_argument("--cache-dir")
    scan.add_argument("--sarif")
    scan.add_argument("--max-signals", type=int, default=50)
    scan.add_argument("--digest-only", action="store_true")
    scan.add_argument("--out")
    scan_ws = blue_sub.add_parser(
        "scan-workspace", parents=[parent],
        help="Triage a read-only workspace directory and rank papers by Layer 0 anomaly count",
    )
    scan_ws.add_argument("--workspace", required=True)
    scan_ws.add_argument("--max-papers", type=int, default=32)
    scan_ws.add_argument("--max-signals-per-paper", type=int, default=25)
    scan_ws.add_argument("--figure-forensics", action="store_true")
    scan_ws.add_argument("--no-recompute-raw", action="store_true")
    scan_ws.add_argument("--no-flow-triage", action="store_true")
    scan_ws.add_argument("--no-internal-consistency", action="store_true")
    scan_ws.add_argument("--cache-dir")
    scan_ws.add_argument("--out")
    validate = blue_sub.add_parser(
        "validate", parents=[parent],
        help="Gate a BLUE report: verbatim quote check, Zero-Drop restoration, 12-column CSV",
    )
    validate.add_argument("--pdf", required=True)
    validate.add_argument("--report", required=True)
    validate.add_argument("--supplement", action="append", nargs="+")
    validate.add_argument("--ledger")
    validate.add_argument("--emit-repair-pack", action="store_true")
    validate.add_argument("--csv")
    validate.add_argument("--out")
    finalize = blue_sub.add_parser(
        "finalize", parents=[parent],
        help="Finalize a BLUE report: apply quote repairs, restore Zero-Drop rows, auto-downgrade unverified quotes",
    )
    finalize.add_argument("--pdf", required=True)
    finalize.add_argument("--report", required=True)
    finalize.add_argument("--repairs")
    finalize.add_argument("--supplement", action="append", nargs="+")
    finalize.add_argument("--ledger")
    finalize.add_argument("--out-report")
    finalize.add_argument("--csv")
    finalize.add_argument("--sarif")
    finalize.add_argument("--out")
    ensemble = blue_sub.add_parser(
        "ensemble", parents=[parent],
        help="Merge 2..12 independent blind BLUE reports with consensus and split-verdict arbitration",
    )
    ensemble.add_argument("--report", required=True, action="append", nargs="+")
    ensemble.add_argument("--rater-id", action="append", nargs="+")
    ensemble.add_argument("--pdf")
    ensemble.add_argument("--supplement", action="append", nargs="+")
    ensemble.add_argument("--ledger")
    ensemble.add_argument("--min-consensus", type=int, default=None)
    ensemble.add_argument("--csv")
    ensemble.add_argument("--sarif")
    ensemble.add_argument("--out")


def _add_red_parser(subparsers, parent):
    red = subparsers.add_parser("red", parents=[parent], help="RED authoring commands")
    red_sub = red.add_subparsers(dest="action", parser_class=_JsonArgumentParser)
    targets = red_sub.add_parser("targets", parents=[parent], help="List addressable targets and baseline signals")
    targets.add_argument("--pdf", required=True)
    targets.add_argument("--page", type=int)
    targets.add_argument("--query")
    targets.add_argument("--include-baseline", action="store_true")
    plan = red_sub.add_parser(
        "plan", parents=[parent],
        help="Propose simulation-verified multi-surface L3/L4 RED mutation bundles",
    )
    plan.add_argument("--pdf", required=True)
    plan.add_argument("--supplement", action="append", nargs="+")
    plan.add_argument("--target-difficulty", choices=["L1", "L2", "L3", "L4"], default="L3")
    plan.add_argument("--max-bundles", type=int, default=5)
    plan.add_argument("--claim")
    plan.add_argument("--red-brief")
    plan.add_argument("--out")
    simulate = red_sub.add_parser("simulate", parents=[parent], help="Simulate Layer 0 detectability without writing a PDF")
    simulate.add_argument("--pdf", required=True)
    simulate.add_argument("--ops", required=True)
    simulate.add_argument("--supplement", action="append", nargs="+")
    simulate.add_argument("--max-signals", type=int, default=50)
    simulate.add_argument("--out")
    trace = red_sub.add_parser("trace", parents=[parent], help="Trace one claim across paper and supplement surfaces")
    trace.add_argument("--pdf", required=True)
    trace.add_argument("--claim", required=True)
    trace.add_argument("--supplement", action="append", nargs="+")
    trace.add_argument("--max-occurrences", type=int, default=40)
    trace.add_argument("--out")
    apply_cmd = red_sub.add_parser("apply", parents=[parent], help="Apply coordinated RED edits to a blind PDF")
    apply_cmd.add_argument("--pdf", required=True)
    apply_cmd.add_argument("--ops", required=True)
    apply_cmd.add_argument("--out-pdf", required=True)
    apply_cmd.add_argument("--out-gold")
    apply_cmd.add_argument("--out-supplement-dir")
    apply_cmd.add_argument("--supplement", action="append", nargs="+")
    apply_cmd.add_argument("--min-difficulty", choices=["L1", "L2", "L3", "L4"], default=None)
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

    round_cmd = arena_sub.add_parser(
        "run-round", parents=[parent],
        help="Run blind BLUE agent commands in a cleanroom and score them",
    )
    round_cmd.add_argument("--pdf", required=True)
    round_cmd.add_argument("--source-pdf")
    round_cmd.add_argument("--supplement", action="append", nargs="+")
    round_cmd.add_argument("--gold")
    round_cmd.add_argument("--baseline")
    round_cmd.add_argument("--agent-cmd", required=True)
    round_cmd.add_argument("--agent-arg", action="append", nargs="+")
    round_cmd.add_argument("--agent-timeout", type=int, default=180)
    round_cmd.add_argument("--runs", type=int, default=1)
    round_cmd.add_argument("--out")

    distill = arena_sub.add_parser(
        "distill", parents=[parent],
        help="Distill a scored round into an answer-key-free harness patch",
    )
    distill.add_argument("--round", required=True)
    distill.add_argument("--gold")
    distill.add_argument("--max-rules", type=int, default=40)
    distill.add_argument("--out")
    _add_arena_evolution_parsers(arena_sub, parent)


def _add_arena_evolution_parsers(arena_sub, parent):
    duel = arena_sub.add_parser(
        "duel", parents=[parent],
        help="Run an isolated RED vs BLUE duel, quote gate, holdout check, and rule distillation",
    )
    duel.add_argument("--source-pdf", required=True)
    duel.add_argument("--red-cmd", required=True)
    duel.add_argument("--red-arg", action="append", nargs="+")
    duel.add_argument("--blue-cmd", required=True)
    duel.add_argument("--blue-arg", action="append", nargs="+")
    duel.add_argument("--supplement", action="append", nargs="+")
    duel.add_argument("--holdout-pdf", action="append", nargs="+")
    duel.add_argument("--red-harness")
    duel.add_argument("--blue-harness")
    duel.add_argument("--min-difficulty", choices=["L1", "L2", "L3", "L4"], default=None)
    duel.add_argument("--runs", type=int, default=1)
    duel.add_argument("--agent-timeout", type=int, default=180)
    duel.add_argument("--max-rules", type=int, default=40)
    duel.add_argument("--no-validate-quotes", action="store_true")
    duel.add_argument("--out")

    apply_patch = arena_sub.add_parser(
        "apply-patch", parents=[parent],
        help="Promote a scrubbed harness patch under generation cap and holdout rollback guard",
    )
    apply_patch.add_argument("--harness", required=True)
    apply_patch.add_argument("--patch", required=True)
    apply_patch.add_argument("--role", choices=["blue", "red"], default=None)
    apply_patch.add_argument("--max-generations", type=int, default=3)
    apply_patch.add_argument("--baseline-holdout-fp", type=int, default=None)
    apply_patch.add_argument("--candidate-holdout-fp", type=int, default=None)
    apply_patch.add_argument("--max-instructions-chars", type=int, default=12000)
    apply_patch.add_argument("--compact-rules", action="store_true")
    apply_patch.add_argument("--out")

    evolve = arena_sub.add_parser(
        "evolve", parents=[parent],
        help="Run a rollback-safe 1..3 generation RED/BLUE co-evolution campaign",
    )
    evolve.add_argument("--source-pdf", required=True, action="append", nargs="+")
    evolve.add_argument("--supplement", action="append", nargs="+")
    evolve.add_argument("--holdout-pdf", action="append", nargs="+")
    evolve.add_argument("--harness")
    evolve.add_argument("--red-harness")
    evolve.add_argument("--role", choices=["blue", "red", "both"], default="blue")
    evolve.add_argument("--red-cmd", required=True)
    evolve.add_argument("--red-arg", action="append", nargs="+")
    evolve.add_argument("--blue-cmd", required=True)
    evolve.add_argument("--blue-arg", action="append", nargs="+")
    evolve.add_argument("--generations", type=int, default=3)
    evolve.add_argument("--min-difficulty", choices=["L1", "L2", "L3", "L4"], default="L3")
    evolve.add_argument("--runs", type=int, default=1)
    evolve.add_argument("--agent-timeout", type=int, default=180)
    evolve.add_argument("--max-rules", type=int, default=40)
    evolve.add_argument("--max-instructions-chars", type=int, default=16000)
    evolve.add_argument("--max-recall-drop", type=float, default=0.0)
    evolve.add_argument("--compact-rules", action="store_true")
    evolve.add_argument("--checkpoint-dir")
    evolve.add_argument("--resume", action="store_true")
    evolve.add_argument("--max-total-seconds", type=float, default=None)
    evolve.add_argument("--out")
    evolve.add_argument("--out-harness")
    evolve.add_argument("--out-red-harness")

    tournament = arena_sub.add_parser(
        "tournament", parents=[parent],
        help="Run an N x M RED-vs-BLUE round-robin tournament with Bradley-Terry and Elo ratings",
    )
    tournament.add_argument("--source-pdf", required=True, action="append", nargs="+")
    tournament.add_argument("--red-entry", required=True, action="append", nargs="+")
    tournament.add_argument("--blue-entry", required=True, action="append", nargs="+")
    tournament.add_argument("--supplement", action="append", nargs="+")
    tournament.add_argument("--holdout-pdf", action="append", nargs="+")
    tournament.add_argument("--min-difficulty", choices=["L1", "L2", "L3", "L4"], default="L2")
    tournament.add_argument("--agent-timeout", type=int, default=180)
    tournament.add_argument("--no-validate-quotes", action="store_true")
    tournament.add_argument("--out")

    bench = arena_sub.add_parser(
        "benchmark", parents=[parent],
        help="Run the 32-case deterministic RED/BLUE + Holdout regression benchmark suite",
    )
    bench.add_argument("--mode", choices=["sensor", "agent"], default="sensor")
    bench.add_argument("--agent-cmd")
    bench.add_argument("--agent-arg", action="append", nargs="+")
    bench.add_argument("--case", action="append", nargs="+")
    bench.add_argument("--baseline-report")
    bench.add_argument("--max-recall-drop", type=float, default=0.0)
    bench.add_argument("--allow-holdout-fp-increase", action="store_true")
    bench.add_argument("--out")


def _build_parser() -> _JsonArgumentParser:
    shared = _JsonArgumentParser(add_help=False)
    shared.add_argument("--timeout", type=float, default=argparse.SUPPRESS)
    root = _JsonArgumentParser(prog="python app/local/falsify_cli.py", description=__doc__)
    root.add_argument("--timeout", type=float, default=None)
    sub = root.add_subparsers(dest="group", parser_class=_JsonArgumentParser)
    _add_blue_parser(sub, shared)
    _add_red_parser(sub, shared)
    _add_blind_and_arena_parsers(sub, shared)
    schemas = sub.add_parser(
        "schemas", parents=[shared],
        help="List or inspect Falsify JSON Schema contracts for agent tool integration",
    )
    schemas.add_argument("--id", default=None)
    schemas.add_argument("--out")
    mcp_config = sub.add_parser(
        "mcp-config", parents=[shared],
        help="Print a stdio MCP client configuration for app/local/paper_mcp.py",
    )
    mcp_config.add_argument("--pdf", required=False, default=None)
    mcp_config.add_argument("--workspace")
    mcp_config.add_argument("--role", choices=["blue", "red", "both"], default="blue")
    mcp_config.add_argument("--analysis", action="store_true")
    mcp_config.add_argument("--oracle", action="store_true")
    mcp_config.add_argument("--supplement", action="append", nargs="+")
    mcp_config.add_argument("--format", choices=["json"], default="json")
    return root


_DISPATCH = {
    ("blue", "scan"): _cmd_blue_scan,
    ("blue", "scan-workspace"): _cmd_blue_scan_workspace,
    ("blue", "validate"): _cmd_blue_validate,
    ("blue", "finalize"): _cmd_blue_finalize,
    ("blue", "ensemble"): _cmd_blue_ensemble,
    ("red", "targets"): _cmd_red_targets,
    ("red", "plan"): _cmd_red_plan,
    ("red", "simulate"): _cmd_red_simulate,
    ("red", "trace"): _cmd_red_trace,
    ("red", "apply"): _cmd_red_apply,
    ("blind", "verify"): _cmd_blind_verify,
    ("arena", "score"): _cmd_arena_score,
    ("arena", "run-round"): _cmd_arena_run_round,
    ("arena", "distill"): _cmd_arena_distill,
    ("arena", "duel"): _cmd_arena_duel,
    ("arena", "apply-patch"): _cmd_arena_apply_patch,
    ("arena", "evolve"): _cmd_arena_evolve,
    ("arena", "tournament"): _cmd_arena_tournament,
    ("arena", "benchmark"): _cmd_arena_benchmark,
    ("schemas", None): _cmd_schemas,
    ("mcp-config", None): _cmd_mcp_config,
}


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        handler = _DISPATCH.get((getattr(args, "group", None), getattr(args, "action", None)))
        if handler is None:
            raise _CliError(
                "invalid_arguments",
                "Specify one of: blue scan, blue scan-workspace, blue validate, blue finalize, red targets, red plan, "
                "red simulate, red trace, red apply, blind verify, arena score, arena run-round, "
                "arena distill, arena duel, arena apply-patch, arena evolve, arena benchmark, mcp-config.",
                exit_code=2,
                recovery_hint="Run with --help to view command groups and actions.",
            )
        timeout_val = getattr(args, "timeout", None)
        deadline = (time.monotonic() + timeout_val) if timeout_val is not None and timeout_val > 0 else None
        payload, code = handler(args, deadline)
        return _emit(payload, code)
    except (_CliError, BlueReportError) as exc:
        return _emit(_error_payload(exc.code, str(exc), exc.recovery_hint, getattr(exc, "extra", None)), exc.exit_code)
    except TimeoutError:
        return _emit(_error_payload("timeout", "Operation timed out.", "Retry with a higher --timeout."), 124)
    except SystemExit as exc:
        return 0 if exc.code in (None, 0) else int(exc.code) if isinstance(exc.code, int) else 2
    except Exception as exc:
        return _emit(_error_payload("internal_error", f"{type(exc).__name__}: {exc}", "Inspect inputs and flags."), 2)


if __name__ == "__main__":
    raise SystemExit(main())
