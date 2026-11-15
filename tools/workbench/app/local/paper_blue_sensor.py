"""BLUE Layer 0 offline PDF forensic sensor with optional P2 external oracle pack."""
from datetime import datetime, timezone
import hashlib
import http.client
import json
import re
import ssl
from urllib.parse import quote, urlsplit

import pymupdf

from paper_clinical_trials import (
    compare_paper_with_registry,
    extract_trial_ids,
    fetch_study_json,
    fetch_trial_record,
)
from paper_evidence_blue import require_summary
from paper_evidence_text import (
    _AUTHOR_START,
    _BRACKET_REF,
    _DOT_REF,
    _YEAR,
    _collect_ref_lines,
    _extract_raw_blocks,
    _open_pdf,
    _order_blocks,
    _repeated_furniture_keys,
    _require_bound_pdf,
    _strip_furniture,
    list_references,
)
from paper_external_grounding import (
    MAX_BYTES as ORACLE_MAX_BYTES,
    TIMEOUT_SECONDS as ORACLE_TIMEOUT,
    USER_AGENT as ORACLE_USER_AGENT,
    _compare_record,
    _is_chimera_mismatch,
    _read_bounded_body,
    _resolve_global_ip,
    fetch_json,
    parse_reference_entry,
    plain,
    verify_bibliography,
)
from paper_figure_forensics import audit_figure_forensics
from paper_registry_identifiers import (
    audit_identifiers_offline,
    verify_identifiers_online,
)
from paper_stat_audit import audit_paper_statistics

SCHEMA = "falsify.blue-defect-sensor.v1"
MAX_AUDIT_PAGES = 80
MAX_WIDGET_FIELDS = 200
MAX_LINKS_RETURNED = 200
MAX_ORACLE_REFS = 25
DATACITE_HOST = "api.datacite.org"

_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales",
})
_VALID_DOI_RE = re.compile(r"(10\.\d{4,9}/[^\s,;\]>?#\"']+)", re.IGNORECASE)
_ANY_DOI_PREFIX_RE = re.compile(
    r"(?:doi\s*:|https?://(?:dx\.)?doi\.org/)\s*([^\s,;\]>?#\"']*)",
    re.IGNORECASE,
)
_BAD_10_PREFIX_RE = re.compile(r"(?<![\d.])(10\.(?:\d{1,3}|\d{10,})/[^\s,;\]>\"']*)")
_PMID_RE = re.compile(
    r"(?:\bPMID\s*[:#]?\s*|pubmed\.ncbi\.nlm\.nih\.gov/|ncbi\.nlm\.nih\.gov/pubmed/|pmid=)(\d{5,10})",
    re.IGNORECASE,
)
_BRACKET_CITE_RE = re.compile(r"\[(\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*)\]")
_MATH_PREFIX_RE = re.compile(r"(?:\bin|∈|range|interval|scale|from)\s*$", re.IGNORECASE)
_TRACKING_QUERY_RE = re.compile(r"(?:^|&)(?:utm_[^=]+|fbclid|gclid)=[^&]*", re.IGNORECASE)


def _default_store():
    from paper_evidence import default_store
    return default_store


def _assert_no_red_keys(obj):
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key in _FORBIDDEN_RED_KEYS:
                raise ValueError("forbidden_red_key")
            _assert_no_red_keys(val)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_red_keys(item)


def _signal(family, kind, subtype, page_index, excerpt, detail, reported, computed, item_id=None):
    sig = {
        "family": family,
        "kind": kind,
        "subtype": subtype,
        "pageIndex": page_index,
        "excerpt": " ".join(str(excerpt or "").split())[:220],
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }
    if item_id is not None:
        sig["itemId"] = item_id
    return sig


def _clean_doi_token(token):
    doi = str(token or "").strip().rstrip(".,;]}\"'")
    while doi.endswith(")") and doi.count(")") > doi.count("("):
        doi = doi[:-1].rstrip(".,;]}\"'")
    return doi


def _extract_valid_dois(text):
    out, seen = [], set()
    for m in _VALID_DOI_RE.finditer(text or ""):
        doi = _clean_doi_token(m.group(1))
        low = doi.lower()
        if len(doi.split("/", 1)[1]) < 2 or ".." in doi:
            continue
        if low not in seen:
            seen.add(low)
            out.append(doi)
    return out


def _extract_pmids(text):
    out, seen = [], set()
    for m in _PMID_RE.finditer(text or ""):
        pmid = m.group(1)
        if pmid not in seen:
            seen.add(pmid)
            out.append(pmid)
    return out


def _looks_like_ref_line(text):
    if _BRACKET_REF.match(text):
        return bool(_YEAR.search(text) or _VALID_DOI_RE.search(text) or "http" in text.lower())
    return False


def _collect_fallback_ref_lines(doc, page_limit):
    lines = []
    for idx in range(page_limit):
        raw_blocks, width, height = _extract_raw_blocks(doc[idx])
        ordered = _order_blocks(raw_blocks, width)
        for blk in ordered:
            for ln in blk["lines"]:
                txt = ln["text"].strip()
                if txt and _looks_like_ref_line(txt):
                    lines.append((idx, ln["bbox"], txt, blk["column"]))
    return lines


def _match_numbered_ref_line(txt, expected):
    bm = _BRACKET_REF.match(txt)
    if bm:
        cand = int(bm.group(1))
        return (cand, bm.group(2).strip()) if 1 <= cand <= 500 else (None, txt)
    dm = _DOT_REF.match(txt)
    if dm:
        cand = int(dm.group(1))
        if 1 <= cand <= 500 and ((expected is None and cand == 1) or cand == expected):
            return cand, dm.group(2).strip()
    return None, txt


def _parse_numbered_with_boxes(ref_lines):
    entries, current, expected = [], None, None
    for page_idx, bbox, txt, _col in ref_lines:
        num, body = _match_numbered_ref_line(txt, expected)
        if num is not None:
            if current is not None:
                entries.append(current)
            current = {"index": num, "pageIndex": page_idx, "lines": [(page_idx, bbox, body or txt)]}
            expected = num + 1
        elif current is not None:
            current["lines"].append((page_idx, bbox, txt))
    if current is not None:
        entries.append(current)
    return entries


def _looks_like_new_ay_ref(current, bbox, txt, col_left):
    prev = " ".join(part[2] for part in current["lines"])
    has_year = bool(_YEAR.search(prev))
    ends_stop = prev.rstrip().endswith((".", ")", "]")) or bool(_VALID_DOI_RE.search(prev))
    return (has_year or ends_stop) and abs(bbox[0] - col_left) <= 5.0 and bool(_AUTHOR_START.match(txt))


def _parse_author_year_with_boxes(ref_lines):
    if not ref_lines:
        return []
    col_lefts = {}
    for _p, bbox, _t, col in ref_lines:
        col_lefts[col] = min(col_lefts[col], bbox[0]) if col in col_lefts else bbox[0]
    entries, current = [], None
    for page_idx, bbox, txt, col in ref_lines:
        if current is None:
            current = {"index": 1, "pageIndex": page_idx, "lines": [(page_idx, bbox, txt)]}
        elif _looks_like_new_ay_ref(current, bbox, txt, col_lefts[col]):
            entries.append(current)
            current = {"index": len(entries) + 1, "pageIndex": page_idx, "lines": [(page_idx, bbox, txt)]}
        else:
            current["lines"].append((page_idx, bbox, txt))
    if current is not None:
        entries.append(current)
    return entries


def _finalize_entries(raw_entries):
    out = []
    for entry in raw_entries:
        raw_text = " ".join(ln[2] for ln in entry["lines"] if ln[2]).strip()
        if not raw_text:
            continue
        years = _YEAR.findall(raw_text)
        out.append({
            "index": entry["index"],
            "pageIndex": entry["pageIndex"],
            "lines": entry["lines"],
            "rawText": raw_text,
            "dois": _extract_valid_dois(raw_text),
            "pmids": _extract_pmids(raw_text),
            "year": int(years[-1]) if years else None,
        })
    return out


def _extract_bib_entries(doc, page_limit):
    ref_lines, found_section = _collect_ref_lines(doc)
    ref_lines = [ln for ln in ref_lines if ln[0] < page_limit]
    if not found_section or not ref_lines:
        fallback = _collect_fallback_ref_lines(doc, page_limit)
        if len(fallback) < 2 and not any(_VALID_DOI_RE.search(ln[2]) for ln in fallback):
            return [], set(), "not_found"
        ref_lines = fallback
    ref_keys = {(p, tuple(b), t) for p, b, t, _ in ref_lines}
    entries = _parse_numbered_with_boxes(ref_lines)
    if len(entries) < 2 and not any(_BRACKET_REF.match(ln[2]) or _DOT_REF.match(ln[2]) for ln in ref_lines[:5]):
        entries = _parse_author_year_with_boxes(ref_lines)
    final = _finalize_entries(entries)
    return final, ref_keys, ("ready" if final else "not_found")


def _entries_by_page(entries):
    by_page = {}
    for entry in entries:
        seen_pages = {ln[0] for ln in entry["lines"]}
        for page_idx in seen_pages:
            by_page.setdefault(page_idx, []).append(entry)
    return by_page


def _match_link_to_entry(page_idx, rect, page_entries):
    best_entry, best_score = None, 0.0
    for entry in page_entries:
        score = 0.0
        for ln_page, lbbox, _txt in entry["lines"]:
            if ln_page != page_idx:
                continue
            lrect = pymupdf.Rect(lbbox) + (-2.5, -2.5, 2.5, 2.5)
            if rect.intersects(lrect):
                score += (rect & lrect).get_area()
        if score > best_score:
            best_score, best_entry = score, entry
    return best_entry


def _is_external_uri(uri):
    low = uri.lower()
    return low.startswith(("http://", "https://", "doi:")) or bool(_VALID_DOI_RE.search(uri))


def _normalize_article_uri(uri):
    low = uri.strip()
    if low.lower().startswith("doi:"):
        dois = _extract_valid_dois(low)
        return ("doi", dois[0].lower()) if dois else None
    dois = _extract_valid_dois(low)
    if dois:
        return ("doi", dois[0].lower())
    pmids = _extract_pmids(low)
    if pmids:
        return ("pmid", pmids[0])
    parts = urlsplit(low)
    if not parts.netloc:
        return None
    path = parts.path.rstrip("/")
    query = _TRACKING_QUERY_RE.sub("", parts.query).strip("&")
    if not path and not query:
        return None
    return ("uri", f"{parts.netloc.lower()}{path}{'?' + query if query else ''}")


def _check_link_mismatch(page_idx, uri, visible_text, matched_entry):
    uri_dois = _extract_valid_dois(uri)
    uri_pmids = _extract_pmids(uri)
    vis_dois = _extract_valid_dois(visible_text) or (matched_entry["dois"] if matched_entry else [])
    vis_pmids = _extract_pmids(visible_text) or (matched_entry["pmids"] if matched_entry else [])
    ref_idx = matched_entry["index"] if matched_entry else None
    excerpt = visible_text or (matched_entry["rawText"] if matched_entry else uri)

    if uri_dois and vis_dois and uri_dois[0].lower() not in {d.lower() for d in vis_dois}:
        return _signal(
            "D2", "uri_visible_doi_mismatch", "identifier-hijack", page_idx, excerpt,
            f"Visible DOI {vis_dois[0]} conflicts with embedded /URI DOI {uri_dois[0]}",
            {"visibleDoi": vis_dois[0], "refIndex": ref_idx},
            {"uriDoi": uri_dois[0], "uri": uri},
        )
    if uri_pmids and vis_pmids and uri_pmids[0] not in vis_pmids:
        return _signal(
            "D2", "uri_visible_doi_mismatch", "identifier-hijack", page_idx, excerpt,
            f"Visible PMID {vis_pmids[0]} conflicts with embedded /URI PMID {uri_pmids[0]}",
            {"visiblePmid": vis_pmids[0], "refIndex": ref_idx},
            {"uriPmid": uri_pmids[0], "uri": uri},
        )
    return None


def _process_one_link(page, idx, link, page_entries, entry_targets):
    uri = str(link.get("uri") or "").strip()
    if not uri or not _is_external_uri(uri):
        return None
    rect = pymupdf.Rect(link["from"]) if link.get("from") else pymupdf.Rect(0, 0, 0, 0)
    visible_text = " ".join(page.get_text("text", clip=rect + (-2, -2, 2, 2)).split())
    matched = _match_link_to_entry(idx, rect, page_entries)
    uri_dois = _extract_valid_dois(uri)
    target = _normalize_article_uri(uri)
    if matched is not None and target is not None:
        entry_targets[id(matched)].add(target)
    sig = _check_link_mismatch(idx, uri, visible_text, matched)
    vis_dois = _extract_valid_dois(visible_text) or (matched["dois"] if matched else [])
    record = {
        "pageIndex": idx,
        "uri": uri[:300],
        "visibleText": visible_text[:160],
        "visibleDoi": vis_dois[0] if vis_dois else None,
        "uriDoi": uri_dois[0] if uri_dois else None,
        "refIndex": matched["index"] if matched else None,
    }
    return sig, bool(uri_dois), record


def _scan_page_links(doc, page_limit, entries):
    by_page = _entries_by_page(entries)
    entry_targets = {id(e): set() for e in entries}
    for entry in entries:
        entry_targets[id(entry)].update(("doi", d.lower()) for d in entry["dois"])
        entry_targets[id(entry)].update(("pmid", p) for p in entry["pmids"])

    signals, link_records = [], []
    total_links, doi_links, mismatch_count = 0, 0, 0
    for idx in range(page_limit):
        page = doc[idx]
        for link in page.get_links() or []:
            processed = _process_one_link(page, idx, link, by_page.get(idx, []), entry_targets)
            if processed is None:
                continue
            sig, has_doi, record = processed
            total_links += 1
            doi_links += 1 if has_doi else 0
            if sig is not None:
                mismatch_count += 1
                signals.append(sig)
            if len(link_records) < MAX_LINKS_RETURNED:
                link_records.append(record)
    return signals, entry_targets, {
        "total": total_links,
        "doiLinks": doi_links,
        "mismatchCount": mismatch_count,
        "sharedTargetCount": 0,
        "links": link_records,
    }


def _detect_shared_targets(entries, entry_targets):
    target_owners = {}
    for entry in entries:
        for target in entry_targets.get(id(entry), ()):
            target_owners.setdefault(target, []).append(entry)
    signals, shared_count = [], 0
    for (kind, value), owners in target_owners.items():
        if len(owners) < 2:
            continue
        shared_count += 1
        indices = [e["index"] for e in owners]
        excerpt = " | ".join(e["rawText"][:95] for e in owners[:2])
        signals.append(_signal(
            "D2", "duplicate_reference_uri_or_doi", "identifier-hijack",
            owners[1]["pageIndex"], excerpt,
            f"Multiple bibliography entries {indices} resolve to shared {kind.upper()} target {value}",
            {"entries": indices},
            {"target": value, "targetKind": kind},
        ))
    return signals, shared_count


def _norm_ref_body(raw_text):
    body = re.sub(r"^\s*(?:\[\d{1,4}\]|\d{1,4}[.)])\s*", "", raw_text or "")
    return re.sub(r"[^a-z0-9\u3131-\uD79D]+", " ", body.lower()).strip()


def _detect_duplicate_entries(entries):
    signals, dup_count = [], 0
    normed = [(_norm_ref_body(e["rawText"]), set(_norm_ref_body(e["rawText"]).split()), e) for e in entries]
    seen_pairs = set()
    for i in range(len(normed)):
        norm_a, tok_a, entry_a = normed[i]
        if len(norm_a) < 25:
            continue
        for j in range(i + 1, len(normed)):
            norm_b, tok_b, entry_b = normed[j]
            if len(norm_b) < 25 or (i, j) in seen_pairs:
                continue
            sim = 1.0 if norm_a == norm_b else (
                len(tok_a & tok_b) / len(tok_a | tok_b) if len(tok_a) >= 6 and len(tok_b) >= 6 else 0.0
            )
            if sim >= 0.90 and (entry_a["year"] is None or entry_b["year"] is None or entry_a["year"] == entry_b["year"]):
                seen_pairs.add((i, j))
                dup_count += 1
                signals.append(_signal(
                    "D2", "duplicate_reference_entry", "duplicate-reference",
                    entry_b["pageIndex"], entry_b["rawText"],
                    f"Reference [{entry_b['index']}] duplicates [{entry_a['index']}] (similarity {sim:.2f})",
                    {"entries": [entry_a["index"], entry_b["index"]]},
                    {"similarity": round(sim, 4)},
                ))
    return signals, dup_count


def _expand_cite_tokens(spec):
    nums = []
    parts = [p.strip() for p in spec.split(",")]
    if any(p == "0" for p in parts):
        return []
    for part in parts:
        rm = re.fullmatch(r"(\d{1,4})\s*[-–—]\s*(\d{1,4})", part)
        if rm:
            a, b = int(rm.group(1)), int(rm.group(2))
            if 1 <= a <= b <= 500 and b - a <= 20:
                nums.extend(range(a, b + 1))
        elif part.isdigit():
            val = int(part)
            if 1 <= val <= 500:
                nums.append(val)
    return nums


def _scan_line_out_of_range(txt, idx, max_ref, seen_oor):
    signals, out_of_range = [], []
    for m in _BRACKET_CITE_RE.finditer(txt):
        prefix = txt[max(0, m.start() - 24):m.start()]
        suffix = txt[m.end():m.end() + 4].lstrip()
        if _MATH_PREFIX_RE.search(prefix) or suffix.startswith(("=", "(")):
            continue
        for k in _expand_cite_tokens(m.group(1)):
            if k > max_ref and (k, idx) not in seen_oor:
                seen_oor.add((k, idx))
                out_of_range.append(k)
                signals.append(_signal(
                    "D2", "citation_index_out_of_range", "citation-numbering-mismatch",
                    idx, txt,
                    f"Body citation [{k}] exceeds max bibliography index {max_ref}",
                    {"citedIndex": k},
                    {"maxRefIndex": max_ref},
                ))
    return signals, out_of_range


def _detect_citation_numbering(doc, page_limit, entries, ref_keys):
    numbered = [e["index"] for e in entries if type(e["index"]) is int and 1 <= e["index"] <= 500]
    if not numbered:
        return [], []
    max_ref = max(numbered)
    signals = []
    present = set(numbered)
    missing = [k for k in range(1, max_ref + 1) if k not in present]
    if missing:
        signals.append(_signal(
            "D2", "missing_reference_number", "citation-numbering-mismatch",
            entries[0]["pageIndex"], f"Missing reference numbers in 1..{max_ref}: {missing[:10]}",
            f"Numbered bibliography 1..{max_ref} is missing {len(missing)} index(es): {missing[:10]}",
            {"presentCount": len(present), "maxRefIndex": max_ref},
            {"missingNumbers": missing[:20]},
        ))
    out_of_range, seen_oor = [], set()
    for idx in range(page_limit):
        raw_blocks, width, _h = _extract_raw_blocks(doc[idx])
        for blk in _order_blocks(raw_blocks, width):
            for ln in blk["lines"]:
                txt = ln["text"].strip()
                if (idx, tuple(ln["bbox"]), txt) not in ref_keys:
                    line_sigs, line_oor = _scan_line_out_of_range(txt, idx, max_ref, seen_oor)
                    signals.extend(line_sigs)
                    out_of_range.extend(line_oor)
    return signals, sorted(set(out_of_range))


def _find_malformed_doi_tokens(text):
    bad = []
    for m in _ANY_DOI_PREFIX_RE.finditer(text or ""):
        token = _clean_doi_token(m.group(1))
        if not token or not _VALID_DOI_RE.fullmatch(token) or len(token.split("/", 1)[1]) < 2 or ".." in token:
            bad.append(m.group(0).strip()[:120])
    for m in _BAD_10_PREFIX_RE.finditer(text or ""):
        tok = m.group(1).strip()[:120]
        if tok not in bad:
            bad.append(tok)
    return bad


def _detect_malformed_dois(entries, link_records):
    signals, seen = [], set()
    for entry in entries:
        for tok in _find_malformed_doi_tokens(entry["rawText"]):
            key = (entry["pageIndex"], tok)
            if key in seen:
                continue
            seen.add(key)
            signals.append(_signal(
                "D2", "malformed_doi", "attribute-corruption",
                entry["pageIndex"], entry["rawText"],
                f"Malformed DOI syntax '{tok}' in reference [{entry['index']}]",
                {"refIndex": entry["index"], "token": tok},
                {"validSyntax": False},
            ))
    for rec in link_records:
        for tok in _find_malformed_doi_tokens(rec["uri"]):
            key = (rec["pageIndex"], tok)
            if key in seen:
                continue
            seen.add(key)
            signals.append(_signal(
                "D2", "malformed_doi", "attribute-corruption",
                rec["pageIndex"], rec["uri"],
                f"Malformed DOI syntax '{tok}' in embedded /URI link",
                {"refIndex": rec["refIndex"], "token": tok},
                {"validSyntax": False},
            ))
    return signals


def _is_widget_filled(field_type, field_value):
    val = field_value.strip()
    if field_type in ("CheckBox", "RadioButton"):
        return bool(val) and val.lower() != "off"
    return bool(val)


def _widget_record(idx, w):
    ftype = str(getattr(w, "field_type_string", "") or "")
    raw_val = getattr(w, "field_value", None)
    fval = "" if raw_val is None else str(raw_val)
    is_filled = _is_widget_filled(ftype, fval)
    return is_filled, ftype in ("Text", "ComboBox", "ListBox"), {
        "pageIndex": idx,
        "fieldName": str(getattr(w, "field_name", "") or ""),
        "fieldLabel": str(getattr(w, "field_label", "") or ""),
        "fieldType": ftype,
        "fieldValue": fval[:300],
    }


def _build_acroform_signal(total, empty, tc_total, tc_blank, rs_blank_pages, fields):
    if not ((tc_total >= 3 and (tc_blank / tc_total) >= 0.5) or rs_blank_pages):
        return []
    first_page = min(rs_blank_pages) if rs_blank_pages else (fields[0]["pageIndex"] if fields else 0)
    return [_signal(
        "D4-1", "acroform_blank_fields", "reporting-summary-incomplete",
        first_page, f"AcroForm fields: {total} total, {empty} empty",
        f"PDF contains {tc_blank}/{tc_total} blank text/choice AcroForm fields",
        {"fieldCount": total, "textChoiceCount": tc_total},
        {"emptyCount": empty, "blankTextChoiceCount": tc_blank},
    )]


def _scan_acroform_widgets(doc, page_limit):
    fields, total, filled, empty = [], 0, 0, 0
    tc_total, tc_blank, rs_blank_pages = 0, 0, set()
    for idx in range(page_limit):
        widgets = list(doc[idx].widgets() or [])
        is_rs = bool(widgets) and "reporting summary" in (doc[idx].get_text("text") or "").lower()
        for w in widgets:
            is_filled, is_tc, rec = _widget_record(idx, w)
            total += 1
            filled += int(is_filled)
            empty += int(not is_filled)
            tc_total += int(is_tc)
            tc_blank += int(is_tc and not is_filled)
            if is_tc and not is_filled and is_rs:
                rs_blank_pages.add(idx)
            if len(fields) < MAX_WIDGET_FIELDS:
                fields.append(rec)
    signals = _build_acroform_signal(total, empty, tc_total, tc_blank, rs_blank_pages, fields)
    return signals, {"fieldCount": total, "filledCount": filled, "emptyCount": empty, "fields": fields}


def _collect_d1_signals(paper_id, actual_hash, max_signals, store):
    audit_res = audit_paper_statistics(paper_id, file_hash=actual_hash, max_signals=max_signals, store=store)
    out = []
    for sig in audit_res.get("signals", []):
        out.append(_signal(
            "D1", sig["kind"], sig["kind"], sig.get("pageIndex", 0),
            sig.get("excerpt", ""), sig.get("detail", ""),
            sig.get("reported"), sig.get("computed"), item_id=sig.get("itemId"),
        ))
    return out


def _fetch_datacite_json(path):
    ip = _resolve_global_ip(DATACITE_HOST)
    conn = http.client.HTTPSConnection(DATACITE_HOST, timeout=ORACLE_TIMEOUT)
    deadline = __import__("time").monotonic() + ORACLE_TIMEOUT
    try:
        sock = __import__("socket").create_connection((ip, 443), timeout=ORACLE_TIMEOUT)
        conn.sock = sock
        tls = ssl.create_default_context().wrap_socket(sock, server_hostname=DATACITE_HOST)
        conn.sock = tls
        conn.request("GET", path, headers={"User-Agent": ORACLE_USER_AGENT, "Accept": "application/json"})
        resp = conn.getresponse()
        if resp.status == 404:
            raw = _read_bounded_body(resp, tls, deadline)
            return 404, None, hashlib.sha256(raw).hexdigest()
        if resp.status != 200:
            raise ValueError(f"api_status_{resp.status}")
        raw = _read_bounded_body(resp, tls, deadline)
        return 200, json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        conn.close()


def _call_datacite(doi, bib_transport):
    path = "/dois/" + quote(doi, safe="")
    try:
        if bib_transport is not None:
            res = bib_transport("datacite", path)
            if isinstance(res, tuple) and len(res) == 3:
                return res[0], res[1], res[2]
            if isinstance(res, tuple) and len(res) == 2:
                return 200, res[0], res[1]
            return None, None, None
        return _fetch_datacite_json(path)
    except Exception:
        return None, None, None


def _datacite_creators(creators):
    authors_list, surnames = [], []
    for c in (creators or [])[:12]:
        if not isinstance(c, dict):
            continue
        raw_name = c.get("name") or f"{c.get('givenName', '')} {c.get('familyName', '')}"
        name = plain(raw_name)
        if name:
            authors_list.append(name)
        fam = plain(c.get("familyName", ""))
        if not fam and name:
            fam = name.split(",")[0].strip() if "," in name else name.split()[-1]
        if fam:
            surnames.append(fam)
    return "; ".join(authors_list)[:1000], surnames


def _first_datacite_text(items, key):
    if isinstance(items, list) and items and isinstance(items[0], dict):
        return plain(items[0].get(key, ""))
    return ""


def _normalize_datacite_record(data, sha, retrieved_at):
    attrs = ((data or {}).get("data") or {}).get("attributes") if isinstance(data, dict) else None
    if not isinstance(attrs, dict):
        return None
    doi = plain(attrs.get("doi", ""))
    title = _first_datacite_text(attrs.get("titles"), "title")
    authors, surnames = _datacite_creators(attrs.get("creators"))
    year = attrs.get("publicationYear") if type(attrs.get("publicationYear")) is int else None
    abstract = _first_datacite_text(attrs.get("descriptions"), "description")[:1200]
    if not title and not doi:
        return None
    return {
        "provider": "datacite",
        "doi": doi,
        "title": title,
        "authors": authors,
        "authorSurnames": surnames,
        "year": year,
        "abstract": abstract,
        "abstractTruncated": False,
        "url": "https://doi.org/" + quote(doi, safe="/") if doi else "",
        "responseSha256": sha,
        "retrievedAt": retrieved_at,
    }


def _apply_datacite_fallback(bib_results, bib_transport):
    updated, verified_datacite = [], 0
    for item in bib_results:
        if item.get("status") != "doi_not_found_in_crossref":
            updated.append(item)
            continue
        doi = (item.get("parsed") or {}).get("doi")
        if not doi:
            updated.append(item)
            continue
        status, data, sha = _call_datacite(doi, bib_transport)
        at = datetime.now(timezone.utc).isoformat()
        if status == 200:
            dc_rec = _normalize_datacite_record(data, sha, at)
            if dc_rec is not None:
                comp = _compare_record(item["parsed"], dc_rec)
                if _is_chimera_mismatch(comp):
                    updated.append({**item, "status": "metadata_mismatch", "provider": "datacite",
                                    "retrievedRecord": dc_rec, "mismatchDetails": comp, "responseSha256": sha})
                else:
                    verified_datacite += 1
                    updated.append({**item, "status": "verified_by_datacite", "provider": "datacite",
                                    "retrievedRecord": dc_rec, "matchDetails": comp, "responseSha256": sha})
                continue
        if status == 404:
            updated.append({**item, "dataciteStatus": 404})
            continue
        updated.append(item)
    return updated, verified_datacite


def _retraction_bib_signal(item, page_idx):
    rtype = item.get("retractionType") or "retraction"
    kind = "expression_of_concern_citation" if rtype == "expression_of_concern" else "retracted_citation"
    doi = (item.get("parsed") or {}).get("doi")
    rec = item.get("retrievedRecord") or {}
    label = doi or rec.get("title") or f"ref [{item.get('index')}]"
    sig = _signal(
        "D2", kind, "retracted-reference",
        page_idx, item.get("rawText", ""),
        f"Cited work ({label}) is flagged as {rtype} by {item.get('provider')}",
        {"refIndex": item.get("index"), "doi": doi},
        {
            "retractionType": rtype,
            "retractionDetails": item.get("retractionDetails"),
            "retrievedTitle": rec.get("title", ""),
        },
    )
    entry = {
        "index": item.get("index"),
        "doi": doi,
        "status": item.get("status"),
        "provider": item.get("provider"),
        "retractionType": rtype,
        "retractionDetails": item.get("retractionDetails"),
        "retrievedTitle": rec.get("title", ""),
        "rawText": str(item.get("rawText") or "")[:220],
    }
    return sig, entry


def _mismatch_bib_signal(item, page_idx):
    st = item.get("status")
    doi = (item.get("parsed") or {}).get("doi")
    mismatched_item = {
        "index": item.get("index"),
        "doi": doi,
        "status": st,
        "provider": item.get("provider"),
        "rawText": str(item.get("rawText") or "")[:220],
    }
    if st == "metadata_mismatch":
        sig = _signal(
            "D2", "doi_metadata_mismatch", "chimera-reference",
            page_idx, item.get("rawText", ""),
            f"DOI {doi} metadata strongly diverges from bibliography text",
            {"refIndex": item.get("index"), "doi": doi},
            item.get("mismatchDetails") or {},
        )
        return sig, mismatched_item
    sig = _signal(
        "D2", "doi_not_found", "unresolved-doi",
        page_idx, item.get("rawText", ""),
        f"DOI {doi} returned 404 from Crossref" + (" and DataCite" if item.get("dataciteStatus") == 404 else ""),
        {"refIndex": item.get("index"), "doi": doi},
        {"dataciteStatus": item.get("dataciteStatus")},
    )
    return sig, mismatched_item


def _oracle_bib_signals(results, entries):
    by_idx = {e["index"]: e["pageIndex"] for e in entries if e["index"] is not None}
    fallback_page = entries[0]["pageIndex"] if entries else 0
    signals, mismatched, retracted_refs = [], [], []
    for item in results:
        page_idx = by_idx.get(item.get("index"), fallback_page)
        if item.get("retracted") is True:
            ret_sig, ret_entry = _retraction_bib_signal(item, page_idx)
            signals.append(ret_sig)
            retracted_refs.append(ret_entry)
        if item.get("status") in ("metadata_mismatch", "doi_not_found_in_crossref"):
            mis_sig, mis_entry = _mismatch_bib_signal(item, page_idx)
            signals.append(mis_sig)
            mismatched.append(mis_entry)
    return signals, mismatched, retracted_refs


def _oracle_trial_checks(page_texts, trial_transport):
    full_text = "\n\n".join(txt for _p, txt in page_texts)
    trial_ids = extract_trial_ids(full_text)
    if not trial_ids:
        return [], []
    records = []
    for nct in trial_ids:
        try:
            records.append(fetch_trial_record(nct, transport=trial_transport or fetch_study_json))
        except Exception:
            records.append({"nctId": nct, "status": "lookup_failed"})
    comp = compare_paper_with_registry(full_text, records)
    signals = []
    for rec in comp.get("registryComparisons", []):
        for flag in rec.get("flags", []):
            if flag in ("potential_outcome_switch", "enrollment_discrepancy_candidate"):
                matched_chk = next((c for c in rec.get("checks", []) if flag in c.get("flags", [])), {})
                excerpt = matched_chk.get("paperExcerpt") or rec.get("briefTitle", "")
                signals.append(_signal(
                    "D4-1", flag, "trial-registry-mismatch", 0, excerpt,
                    f"Registry check for {rec.get('nctId')} flagged {flag}",
                    {"nctId": rec.get("nctId"), "excerpt": excerpt},
                    {"registeredEnrollment": rec.get("registeredEnrollment"), "flag": flag},
                ))
    return signals, comp.get("registryComparisons", [])


def _run_external_oracle(
    paper_id, entries, page_texts, store, bib_transport, trial_transport,
    extracted_identifiers=None, identifier_transport=None,
):
    refs = list_references(paper_id, offset=0, limit=MAX_ORACLE_REFS, store=store).get("references") or []
    if not refs and entries:
        refs = [{"index": e["index"], "rawText": e["rawText"], "doi": e["dois"][0] if e["dois"] else None, "year": e["year"]}
                for e in entries[:MAX_ORACLE_REFS]]
    bib_out = verify_bibliography(refs, max_refs=MAX_ORACLE_REFS, transport=bib_transport or fetch_json) if refs else {
        "status": "empty", "checkedCount": 0, "summary": {}, "results": [],
    }
    updated_results, dc_count = _apply_datacite_fallback(bib_out.get("results", []), bib_transport)
    bib_summary = dict(bib_out.get("summary") or {})
    if dc_count:
        bib_summary["verifiedByDatacite"] = dc_count
        bib_summary["doiNotFoundInCrossref"] = max(0, bib_summary.get("doiNotFoundInCrossref", 0) - dc_count)
        bib_summary["verifiedMatch"] = bib_summary.get("verifiedMatch", 0)
    bib_signals, mismatched, retracted_refs = _oracle_bib_signals(updated_results, entries)
    trial_signals, registry_comparisons = _oracle_trial_checks(page_texts, trial_transport)
    id_res = verify_identifiers_online(extracted_identifiers or {}, transport=identifier_transport)
    id_signals = id_res.get("signals", [])
    oracle_pack = {
        "tier": "P2",
        "bibliographySummary": {"status": bib_out.get("status"), "checkedCount": bib_out.get("checkedCount", 0), "counts": bib_summary},
        "mismatchedReferences": mismatched[:MAX_ORACLE_REFS],
        "retractedReferences": retracted_refs[:MAX_ORACLE_REFS],
        "registryComparisons": registry_comparisons,
        "identifierChecks": {k: v for k, v in id_res.items() if k != "signals"},
    }
    _assert_no_red_keys(oracle_pack)
    return bib_signals + id_signals + trial_signals, oracle_pack


def _dedupe_and_number(signals, max_signals):
    seen, unique = set(), []
    for sig in signals:
        key = (sig["family"], sig["kind"], sig["pageIndex"], sig.get("itemId"), sig["excerpt"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    truncated = len(unique) > max_signals
    numbered = [{"id": f"sens-{i + 1}", **sig} for i, sig in enumerate(unique[:max_signals])]
    return numbered, truncated


def _figure_forensics(paper_id, actual_hash, max_signals, store):
    result = audit_figure_forensics(paper_id, file_hash=actual_hash, max_signals=max_signals, store=store)
    signals = [
        _signal(
            sig["family"], sig["kind"], sig.get("subtype") or sig["kind"], sig.get("pageIndex", 0),
            sig.get("excerpt", ""), sig.get("detail", ""),
            sig.get("reported"), sig.get("computed"), item_id=sig.get("itemId"),
        )
        for sig in result.get("signals", [])
    ]
    summary = {
        "enabled": True,
        "signalCount": result.get("signalCount", 0),
        "figureCount": result.get("figureCount", 0),
    }
    return signals, summary


def run_blue_sensor(
    paper_id,
    file_hash=None,
    *,
    max_signals=50,
    include_external_oracle=False,
    store=None,
    bib_transport=None,
    trial_transport=None,
    identifier_transport=None,
    include_figure_forensics=False,
):
    """Run BLUE Layer 0 offline PDF forensic sensor (and opt-in P2 oracle pack)."""
    if isinstance(max_signals, bool) or type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")
    if type(include_external_oracle) is not bool:
        raise ValueError("include_external_oracle")
    if type(include_figure_forensics) is not bool:
        raise ValueError("include_figure_forensics")
    store = _default_store() if store is None else store
    paper_id, actual_hash, summary, raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)

    with _open_pdf(raw) as doc:
        page_limit = min(doc.page_count, MAX_AUDIT_PAGES)
        page_texts = [(idx, doc[idx].get_text("text") or "") for idx in range(page_limit)]
        entries, ref_keys, bib_status = _extract_bib_entries(doc, page_limit)
        link_sigs, entry_targets, uri_summary = _scan_page_links(doc, page_limit, entries)
        shared_sigs, shared_count = _detect_shared_targets(entries, entry_targets)
        uri_summary["sharedTargetCount"] = shared_count
        dup_sigs, dup_count = _detect_duplicate_entries(entries)
        cite_sigs, out_of_range = _detect_citation_numbering(doc, page_limit, entries, ref_keys)
        mal_sigs = _detect_malformed_dois(entries, uri_summary["links"])
        acro_sigs, acro_summary = _scan_acroform_widgets(doc, page_limit)

    id_audit = audit_identifiers_offline(page_texts)
    id_offline_sigs = id_audit["signals"]
    extracted_identifiers = id_audit["identifiers"]
    d1_sigs = _collect_d1_signals(paper_id, actual_hash, max_signals, store)
    oracle_sigs, oracle_pack = (
        _run_external_oracle(
            paper_id, entries, page_texts, store, bib_transport, trial_transport,
            extracted_identifiers=extracted_identifiers, identifier_transport=identifier_transport,
        )
        if include_external_oracle else ([], None)
    )
    fig_sigs, fig_summary = (
        _figure_forensics(paper_id, actual_hash, max_signals, store)
        if include_figure_forensics else ([], None)
    )
    all_signals = (
        link_sigs + shared_sigs + dup_sigs + cite_sigs + mal_sigs
        + id_offline_sigs + acro_sigs + oracle_sigs + d1_sigs + fig_sigs
    )
    capped, truncated = _dedupe_and_number(all_signals, max_signals)
    result = {
        "schema": SCHEMA,
        "paperId": paper_id,
        "fileHash": actual_hash,
        "tier": "P2" if include_external_oracle else "P0",
        "signalCount": len(capped),
        "truncated": truncated,
        "signals": capped,
        "uriLinks": uri_summary,
        "acroForm": acro_summary,
        "identifiers": extracted_identifiers,
        "bibliography": {
            "status": bib_status,
            "referenceCount": len(entries),
            "duplicateCount": dup_count,
            "outOfRangeCitations": out_of_range,
        },
        "oraclePack": oracle_pack,
    }
    if fig_summary is not None:
        result["figureForensics"] = fig_summary
    _assert_no_red_keys(result)
    return result
