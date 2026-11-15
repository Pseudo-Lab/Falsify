"""Supplement bundle loading and opt-in P2 external oracle payloads for paper_mcp."""
import hashlib
import io
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import paper_blue_sensor
from paper_clinical_trials import (
    COMPARISON_FRAMING,
    compare_paper_with_registry,
    extract_trial_ids,
    fetch_study_json,
    fetch_trial_record,
)
from paper_evidence_blue import require_summary
from paper_evidence_text import _open_pdf, _require_bound_pdf, list_references
from paper_external_grounding import (
    CROSSREF_404_NOTE,
    MISSING_MATCH_NOTE,
    SCOPE_NOTE,
    fetch_json,
    ground_cited_claims,
    verify_bibliography,
)
from paper_registry_identifiers import (
    MAX_LOOKUPS_LIMIT,
    TRUTHFULNESS_NOTE,
    extract_scientific_identifiers,
    verify_identifiers_online,
)
from paper_figure_forensics import audit_figure_forensics
from paper_raw_dataset_audit import audit_raw_datasets
from paper_supplement_audit import audit_paper_with_supplements, infer_supplement_kind

MAX_SUPPLEMENTS = 12
MAX_BUNDLE_BYTES = 25 * 1024 * 1024
MAX_PDF_SUPP_PAGES = 80
MAX_READ_LIMIT = 24000
MAX_SIGNALS_LIMIT = 100
MAX_ORACLE_REFS = 50
TEXT_EXTENSIONS = frozenset({
    ".csv", ".tsv", ".json", ".md", ".txt", ".log",
    ".py", ".r", ".sql", ".tex", ".yaml", ".yml",
})
FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales",
})


def _assert_no_red_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_RED_KEYS:
                raise ValueError("forbidden_red_key")
            _assert_no_red_keys(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_red_keys(item)


def _extract_text_blob(raw):
    if b"\x00" in raw:
        raise ValueError("paper_evidence_supplement_invalid")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def _extract_json_text(raw):
    text = _extract_text_blob(raw)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text
    _assert_no_red_keys(parsed)
    return text


def _extract_pdf_text(raw):
    if not raw.startswith(b"%PDF-"):
        raise ValueError("paper_evidence_supplement_invalid")
    try:
        doc = _open_pdf(raw)
    except Exception:
        raise ValueError("paper_evidence_supplement_invalid") from None
    try:
        limit = min(doc.page_count, MAX_PDF_SUPP_PAGES)
        return "\n\n".join((doc[i].get_text("text") or "") for i in range(limit))
    finally:
        doc.close()


def _docx_paragraph_text(para):
    parts = []
    for elem in para.iter():
        tag = elem.tag
        if (tag == "t" or tag.endswith("}t")) and elem.text:
            parts.append(elem.text)
        elif tag == "tab" or tag.endswith("}tab"):
            parts.append("\t")
        elif tag == "br" or tag.endswith("}br"):
            parts.append("\n")
    return "".join(parts).strip()


def _extract_docx_text(raw):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            if "word/document.xml" not in zf.namelist():
                raise ValueError("paper_evidence_supplement_invalid")
            info = zf.getinfo("word/document.xml")
            if info.file_size > MAX_BUNDLE_BYTES:
                raise ValueError("paper_evidence_supplement_invalid")
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
    except (zipfile.BadZipFile, ET.ParseError, KeyError, OSError):
        raise ValueError("paper_evidence_supplement_invalid") from None
    paragraphs = []
    for elem in root.iter():
        if elem.tag == "p" or elem.tag.endswith("}p"):
            text = _docx_paragraph_text(elem)
            if text:
                paragraphs.append(text)
    return "\n".join(paragraphs)


def _decode_supplement(ext, raw):
    if ext == ".json":
        return _extract_json_text(raw)
    if ext in TEXT_EXTENSIONS:
        return _extract_text_blob(raw)
    if ext == ".pdf":
        return _extract_pdf_text(raw)
    if ext == ".docx":
        return _extract_docx_text(raw)
    raise ValueError("paper_evidence_supplement_invalid")


def _load_one_supplement(raw_path, index, running_bytes):
    path = Path(raw_path)
    try:
        if not path.is_file():
            raise ValueError("paper_evidence_supplement_invalid")
        size = path.stat().st_size
        if size <= 0 or running_bytes + size > MAX_BUNDLE_BYTES:
            raise ValueError("paper_evidence_supplement_invalid")
        raw = path.read_bytes()
    except ValueError:
        raise
    except OSError:
        raise ValueError("paper_evidence_supplement_invalid") from None
    if len(raw) != size:
        raise ValueError("paper_evidence_supplement_invalid")
    text = _decode_supplement(path.suffix.lower(), raw)
    entry = {
        "supplementId": f"supp-{index + 1}",
        "name": path.name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "kind": infer_supplement_kind(path.name),
        "byteLength": len(raw),
        "charCount": len(text),
        "text": text,
    }
    return entry, running_bytes + len(raw)


def load_selected_supplements(paths):
    """Load up to 12 read-only supplement files (<= 25 MiB total) with blindness guards."""
    if not paths:
        return []
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_SUPPLEMENTS:
        raise ValueError("paper_evidence_supplement_invalid")
    bundle = []
    running_bytes = 0
    for idx, raw_path in enumerate(paths):
        entry, running_bytes = _load_one_supplement(raw_path, idx, running_bytes)
        bundle.append(entry)
    return bundle


def list_supplements_payload(paper_id, file_hash, bundle):
    """Return compact metadata for startup-attached supplement files without raw text."""
    items = [
        {
            "supplementId": item["supplementId"],
            "name": item["name"],
            "sha256": item["sha256"],
            "kind": item["kind"],
            "byteLength": item["byteLength"],
            "charCount": item["charCount"],
        }
        for item in (bundle or [])
    ]
    return {
        "schema": "falsify.mcp-supplements.v1",
        "paperId": paper_id,
        "fileHash": file_hash,
        "supplementCount": len(items),
        "supplements": items,
    }


def read_supplement_payload(paper_id, file_hash, bundle, supplement_id, offset=0, limit=8000):
    """Paginated read-only text slice for one startup-attached supplement."""
    if type(supplement_id) is not str or not supplement_id:
        raise ValueError("paper_evidence_unknown_id")
    if type(offset) is not int or offset < 0:
        raise ValueError("offset")
    if type(limit) is not int or not 1 <= limit <= MAX_READ_LIMIT:
        raise ValueError("limit")
    item = next((s for s in (bundle or []) if s["supplementId"] == supplement_id), None)
    if item is None:
        raise ValueError("paper_evidence_unknown_id")
    text = item["text"]
    total = len(text)
    chunk = text[offset:offset + limit]
    end = offset + len(chunk)
    truncated = end < total
    return {
        "schema": "falsify.mcp-supplement-chunk.v1",
        "paperId": paper_id,
        "fileHash": file_hash,
        "supplementId": item["supplementId"],
        "name": item["name"],
        "sha256": item["sha256"],
        "kind": item["kind"],
        "offset": offset,
        "limit": limit,
        "charCount": total,
        "text": chunk,
        "nextOffset": end if truncated else None,
        "truncated": truncated,
    }


def _visual_page_text(page):
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


def _read_pdf_page_items(raw, max_pages=MAX_PDF_SUPP_PAGES):
    with _open_pdf(raw) as doc:
        limit = min(doc.page_count, max_pages)
        return [
            {"id": f"p{idx}", "pageIndex": idx, "text": _visual_page_text(doc[idx])}
            for idx in range(limit)
        ]


def audit_supplements_payload(store, paper_id, file_hash, bundle, max_signals=50):
    """Run deterministic cross-document supplement audit across bound PDF pages and bundle."""
    if type(max_signals) is not int or not 1 <= max_signals <= MAX_SIGNALS_LIMIT:
        raise ValueError("limit")
    bound_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=bound_id, file_hash=file_hash)
    page_items = _read_pdf_page_items(raw, MAX_PDF_SUPP_PAGES)
    report = audit_paper_with_supplements(page_items, list(bundle or []))
    all_signals = report.get("signals") or []
    capped = all_signals[:max_signals]
    out = {
        **report,
        "paperId": bound_id,
        "fileHash": actual_hash,
        "signalCount": len(capped),
        "truncated": len(all_signals) > max_signals,
        "signals": capped,
    }
    _assert_no_red_keys(out)
    return out


def _compact_sensor_digest(res):
    signals = res.get("signals") or []
    by_family = {}
    for sig in signals:
        fam = sig.get("family") or "unknown"
        by_family[fam] = by_family.get(fam, 0) + 1
    uri_links = res.get("uriLinks") or {}
    acro_form = res.get("acroForm") or {}
    digest = {
        "schema": res.get("schema"),
        "paperId": res.get("paperId"),
        "fileHash": res.get("fileHash"),
        "tier": res.get("tier"),
        "digestOnly": True,
        "signalCount": res.get("signalCount", len(signals)),
        "truncated": bool(res.get("truncated")),
        "counts": {
            "total": res.get("signalCount", len(signals)),
            "byFamily": by_family,
            "uriTotal": uri_links.get("total", 0),
            "uriMismatch": uri_links.get("mismatchCount", 0),
            "sharedTargetCount": uri_links.get("sharedTargetCount", 0),
            "acroFormFields": acro_form.get("fieldCount", 0),
            "acroFormEmpty": acro_form.get("emptyCount", 0),
            "identifiers": (res.get("identifiers") or {}).get("counts", {}),
        },
        "signals": signals,
        "bibliography": res.get("bibliography"),
    }
    if res.get("figureForensics") is not None:
        digest["figureForensics"] = res["figureForensics"]
    return digest


def _table_listing(store, paper_id):
    if not hasattr(store, "list_items"):
        return []
    try:
        listing = store.list_items(paper_id, kind="table")
    except TypeError:
        return _table_listing_fallback(store, paper_id)
    except Exception:
        return []
    if isinstance(listing, dict):
        return list(listing.get("items") or [])
    if isinstance(listing, list):
        return listing
    return []


def _table_listing_fallback(store, paper_id):
    try:
        listing = store.list_items(paper_id)
    except Exception:
        return []
    if isinstance(listing, dict):
        return list(listing.get("items") or [])
    return list(listing) if isinstance(listing, list) else []


def _read_table_item(store, paper_id, item):
    item_id = item.get("id") or item.get("itemId")
    if not item_id or not hasattr(store, "read_item"):
        return item
    try:
        full = store.read_item(paper_id, item_id)
    except Exception:
        return item
    return full if isinstance(full, dict) else item


def _read_table_items(store, paper_id):
    tables = []
    for item in _table_listing(store, paper_id):
        if isinstance(item, dict) and item.get("type") in (None, "table"):
            tables.append(_read_table_item(store, paper_id, item))
    return tables


def _filter_bundle(bundle, supplement_id):
    items = list(bundle or [])
    if supplement_id is None:
        return items
    if type(supplement_id) is not str or not supplement_id:
        raise ValueError("paper_evidence_unknown_id")
    matched = [item for item in items if item.get("supplementId") == supplement_id]
    if not matched:
        raise ValueError("paper_evidence_unknown_id")
    return matched


def audit_figures_payload(store, paper_id, file_hash, max_signals=30, dpi=96, max_figures=24):
    """Run read-only figure-panel forensics for the bound PDF."""
    out = audit_figure_forensics(
        paper_id,
        file_hash=file_hash,
        max_signals=max_signals,
        dpi=dpi,
        max_figures=max_figures,
        store=store,
    )
    _assert_no_red_keys(out)
    return out


def recompute_raw_supplement_payload(store, paper_id, file_hash, bundle, supplement_id=None, max_signals=50):
    """Recompute row-level supplement statistics against bound PDF pages and tables."""
    if type(max_signals) is not int or not 1 <= max_signals <= MAX_SIGNALS_LIMIT:
        raise ValueError("limit")
    items = _filter_bundle(bundle, supplement_id)
    bound_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=bound_id, file_hash=file_hash)
    page_items = _read_pdf_page_items(raw, MAX_PDF_SUPP_PAGES)
    table_items = _read_table_items(store, bound_id)
    out = audit_raw_datasets(page_items, items, table_items=table_items, max_signals=max_signals)
    out["paperId"] = bound_id
    out["fileHash"] = actual_hash
    _assert_no_red_keys(out)
    return out


def run_blue_sensor_payload(store, paper_id, file_hash, max_signals=50, digest_only=False, include_figure_forensics=False):
    """Run offline Layer 0 BLUE PDF forensic sensor and optionally compact to digestOnly."""
    if type(digest_only) is not bool:
        raise ValueError("digest_only")
    if type(include_figure_forensics) is not bool:
        raise ValueError("include_figure_forensics")
    res = paper_blue_sensor.run_blue_sensor(
        paper_id,
        file_hash=file_hash,
        max_signals=max_signals,
        include_external_oracle=False,
        store=store,
        include_figure_forensics=include_figure_forensics,
    )
    return _compact_sensor_digest(res) if digest_only else res


def verify_references_payload(
    store,
    paper_id,
    file_hash,
    max_refs=25,
    include_claim_grounding=False,
    transport=None,
):
    """Opt-in P2 bibliography verification (Crossref/EuropePMC) and optional claim grounding."""
    if type(max_refs) is not int or not 1 <= max_refs <= MAX_ORACLE_REFS:
        raise ValueError("limit")
    if type(include_claim_grounding) is not bool:
        raise ValueError("include_claim_grounding")
    bound_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=bound_id, file_hash=file_hash)
    refs = list_references(bound_id, offset=0, limit=max_refs, store=store).get("references") or []
    active_transport = fetch_json if transport is None else transport
    bibliography = verify_bibliography(refs, max_refs=max_refs, transport=active_transport)
    claim_groundings = None
    if include_claim_grounding:
        page_items = _read_pdf_page_items(raw, MAX_PDF_SUPP_PAGES)
        claim_groundings = ground_cited_claims(page_items, refs, max_claims=12, transport=active_transport)
    out = {
        "schema": "falsify.mcp-reference-oracle.v1",
        "paperId": bound_id,
        "fileHash": actual_hash,
        "bibliography": bibliography,
        "claimGroundings": claim_groundings,
        "limitations": f"{SCOPE_NOTE} {MISSING_MATCH_NOTE} {CROSSREF_404_NOTE}",
    }
    _assert_no_red_keys(out)
    return out


def _fetch_trial_records_safe(trial_ids, transport):
    records = []
    for nct in trial_ids:
        try:
            records.append(fetch_trial_record(nct, transport=transport))
        except Exception as exc:
            records.append({"nctId": nct, "status": "lookup_failed", "error": type(exc).__name__})
    return records


def verify_registries_payload(
    store,
    paper_id,
    file_hash,
    max_lookups=20,
    registry_transport=None,
    identifier_fetcher=None,
):
    """Opt-in P2 ClinicalTrials.gov v2 and OSF/PROSPERO/GEO/PDB identifier verification."""
    if type(max_lookups) is not int or not 1 <= max_lookups <= MAX_LOOKUPS_LIMIT:
        raise ValueError("limit")
    bound_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=bound_id, file_hash=file_hash)
    page_items = _read_pdf_page_items(raw, MAX_PDF_SUPP_PAGES)
    full_text = "\n\n".join(item["text"] for item in page_items)
    trial_ids = extract_trial_ids(full_text)
    active_trial_transport = fetch_study_json if registry_transport is None else registry_transport
    trial_records = _fetch_trial_records_safe(trial_ids, active_trial_transport)
    comp = (
        compare_paper_with_registry(full_text, trial_records)
        if trial_records
        else {"status": "empty", "registryComparisons": [], "extractedSentenceCount": 0, "note": COMPARISON_FRAMING}
    )
    extracted = extract_scientific_identifiers(full_text)
    identifiers = verify_identifiers_online(extracted, transport=identifier_fetcher, max_lookups=max_lookups)
    out = {
        "schema": "falsify.mcp-registry-oracle.v1",
        "paperId": bound_id,
        "fileHash": actual_hash,
        "clinicalTrials": {
            "trialIds": trial_ids,
            "records": trial_records,
            "status": comp.get("status", "empty"),
            "extractedSentenceCount": comp.get("extractedSentenceCount", 0),
        },
        "registryComparisons": comp.get("registryComparisons", []),
        "identifiers": identifiers,
        "limitations": f"{TRUTHFULNESS_NOTE} {COMPARISON_FRAMING}",
    }
    _assert_no_red_keys(out)
    return out
