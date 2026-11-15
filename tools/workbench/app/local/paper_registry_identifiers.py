"""Offline syntax audit and bounded P2 online verification for OSF, PROSPERO, GEO, and PDB identifiers."""
from datetime import datetime, timezone
import hashlib
import http.client
import json
import re
import socket
import ssl
import time
from urllib.parse import quote

from paper_clinical_trials import extract_trial_ids
from paper_external_grounding import (
    MAX_BYTES,
    TIMEOUT_SECONDS,
    USER_AGENT,
    _read_bounded_body,
    _resolve_global_ip,
)

SCHEMA = "falsify.registry-identifiers.v1"
HOSTS = {
    "osf": "api.osf.io",
    "ncbi": "eutils.ncbi.nlm.nih.gov",
    "rcsb": "data.rcsb.org",
}
MAX_LOOKUPS_LIMIT = 30
OSF_RESERVED_SLUGS = frozenset({
    "login", "share", "about", "registries", "preprints", "files", "users",
    "oauth", "admin", "terms", "study", "tools", "token", "links", "search",
    "nodes", "wikis", "forks",
})
PROSPERO_MIN_PREFIX = 42010
PROSPERO_MAX_PREFIX = 42035

TRUTHFULNESS_NOTE = (
    "API 404 or an embargoed/private registration does not prove fabrication by itself, "
    "though an unresolved public accession or a confirmed retraction notice is a high-priority verification signal."
)
PROSPERO_NOTE = (
    "NIHR PROSPERO lacks an unauthenticated JSON REST endpoint; offline structural syntax is checked "
    "(CRD42010..CRD42035 prefix), while private, pending, or embargoed records cannot be queried automatically."
)

_OSF_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:https?://)?(?:www\.)?osf\.io/([a-z0-9]{5})(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_PROSPERO_RE = re.compile(r"\bCRD(\d{8,14})\b", re.IGNORECASE)
_GEO_RE = re.compile(r"\b(GSE\d{3,9})\b", re.IGNORECASE)
_PDB_RE = re.compile(
    r"(?:PDB(?:\s+(?:ID|code|entry|accession))?\s*[:#]?\s*|rcsb\.org/structure/)([1-9][A-Za-z0-9]{3})\b",
    re.IGNORECASE,
)


def _validate_request(provider, path):
    if provider not in HOSTS:
        raise ValueError("unknown_provider")
    if not isinstance(path, str) or not path.startswith("/") or any(ord(c) < 32 for c in path):
        raise ValueError("invalid_api_path")
    return HOSTS[provider]


def fetch_identifier_json(provider, path):
    """Bounded HTTPS GET on fixed allowlisted registry API hosts. No redirects, cookies, or auth."""
    host = _validate_request(provider, path)
    ip = _resolve_global_ip(host)
    connection = http.client.HTTPSConnection(host, timeout=TIMEOUT_SECONDS)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        sock = socket.create_connection((ip, 443), timeout=TIMEOUT_SECONDS)
        connection.sock = sock
        sock.settimeout(max(0.01, deadline - time.monotonic()))
        tls = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        connection.sock = tls
        tls.settimeout(max(0.01, deadline - time.monotonic()))
        connection.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        response = connection.getresponse()
        if response.status == 404:
            raw = _read_bounded_body(response, tls, deadline)
            return 404, None, hashlib.sha256(raw).hexdigest()
        if response.status != 200:
            raise ValueError(f"api_status_{response.status}")
        if "json" not in response.getheader("Content-Type", "").lower():
            raise ValueError("api_content_type")
        raw = _read_bounded_body(response, tls, deadline)
        return 200, json.loads(raw), hashlib.sha256(raw).hexdigest()
    finally:
        connection.close()


def _dedupe_matches(pattern, text, transform, exclude=()):
    out, seen = [], set()
    for m in pattern.finditer(text):
        val = transform(m.group(1))
        if val in exclude or val in seen:
            continue
        seen.add(val)
        out.append(val)
    return out


def extract_scientific_identifiers(text):
    """Extract and deduplicate OSF, PROSPERO, GEO, PDB, and NCT identifiers from text."""
    if not isinstance(text, str) or not text:
        empty = {"osf": [], "prospero": [], "geo": [], "pdb": [], "nct": []}
        return {
            "schema": SCHEMA,
            **empty,
            "counts": {k: 0 for k in empty},
            "totalCount": 0,
        }
    osf = _dedupe_matches(_OSF_RE, text, lambda s: s.lower(), exclude=OSF_RESERVED_SLUGS)
    prospero = _dedupe_matches(_PROSPERO_RE, text, lambda d: f"CRD{d}")
    geo = _dedupe_matches(_GEO_RE, text, lambda g: g.upper())
    pdb = _dedupe_matches(_PDB_RE, text, lambda p: p.upper())
    nct = extract_trial_ids(text)
    counts = {
        "osf": len(osf),
        "prospero": len(prospero),
        "geo": len(geo),
        "pdb": len(pdb),
        "nct": len(nct),
    }
    return {
        "schema": SCHEMA,
        "osf": osf,
        "prospero": prospero,
        "geo": geo,
        "pdb": pdb,
        "nct": nct,
        "counts": counts,
        "totalCount": sum(counts.values()),
    }


def is_valid_prospero_id(crd_id):
    """Return True if a CRD########.. identifier has a plausible PROSPERO year prefix (42010..42035)."""
    if not isinstance(crd_id, str):
        return False
    m = re.fullmatch(r"CRD(\d{8,14})", crd_id.strip(), re.IGNORECASE)
    if not m:
        return False
    digits = m.group(1)
    prefix5 = int(digits[:5])
    return digits.startswith("420") and PROSPERO_MIN_PREFIX <= prefix5 <= PROSPERO_MAX_PREFIX


def _is_placeholder_osf(osf_id):
    low = (osf_id or "").lower()
    return len(low) == 5 and len(set(low)) == 1


def _is_placeholder_geo(geo_id):
    digits = (geo_id or "")[3:]
    return bool(digits) and (digits == "0" * len(digits) or (len(digits) >= 4 and digits == "9" * len(digits)))


def _is_placeholder_nct(nct_id):
    return (nct_id or "").upper() == "NCT00000000"


def _make_signal(family, kind, subtype, page_index, excerpt, detail, reported, computed):
    return {
        "family": family,
        "kind": kind,
        "subtype": subtype,
        "pageIndex": page_index,
        "excerpt": " ".join(str(excerpt or "").split())[:220],
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }


def _normalize_pages(text_or_pages):
    if isinstance(text_or_pages, str):
        return [(0, text_or_pages)]
    if isinstance(text_or_pages, (list, tuple)):
        return [(int(p), str(t or "")) for p, t in text_or_pages]
    raise ValueError("text_or_pages_invalid")


def _find_page_excerpt(pages, needle_pattern, target_upper):
    for page_idx, txt in pages:
        for m in needle_pattern.finditer(txt):
            if m.group(1).upper() == target_upper:
                start = max(0, m.start() - 40)
                end = min(len(txt), m.end() + 60)
                return page_idx, txt[start:end]
    return (pages[0][0] if pages else 0), target_upper


def audit_identifiers_offline(full_text):
    """P0 offline structural audit of registry/accession identifiers (0 network calls)."""
    pages = _normalize_pages(full_text)
    joined = "\n\n".join(txt for _p, txt in pages)
    extracted = extract_scientific_identifiers(joined)
    signals = []
    for crd_id in extracted["prospero"]:
        if not is_valid_prospero_id(crd_id):
            page_idx, excerpt = _find_page_excerpt(pages, _PROSPERO_RE, crd_id[3:].upper())
            signals.append(_make_signal(
                "D4-1", "malformed_prospero_id", "malformed-registry-id", page_idx, excerpt,
                f"PROSPERO identifier {crd_id} has invalid year prefix outside {PROSPERO_MIN_PREFIX}..{PROSPERO_MAX_PREFIX}",
                {"prosperoId": crd_id},
                {"validSyntax": False, "expectedPrefixRange": f"CRD{PROSPERO_MIN_PREFIX}..CRD{PROSPERO_MAX_PREFIX}"},
            ))
    for osf_id in extracted["osf"]:
        if _is_placeholder_osf(osf_id):
            page_idx, excerpt = _find_page_excerpt(pages, _OSF_RE, osf_id.upper())
            signals.append(_make_signal(
                "D4-1", "placeholder_osf_id", "placeholder-registry-id", page_idx, excerpt,
                f"Placeholder OSF identifier osf.io/{osf_id} detected",
                {"osfId": osf_id},
                {"validSyntax": False, "reason": "placeholder_identifier"},
            ))
    for geo_id in extracted["geo"]:
        if _is_placeholder_geo(geo_id):
            page_idx, excerpt = _find_page_excerpt(pages, _GEO_RE, geo_id.upper())
            signals.append(_make_signal(
                "D2", "placeholder_geo_accession", "placeholder-registry-id", page_idx, excerpt,
                f"Placeholder GEO accession {geo_id} detected",
                {"geoId": geo_id},
                {"validSyntax": False, "reason": "placeholder_identifier"},
            ))
    for nct_id in extracted["nct"]:
        if _is_placeholder_nct(nct_id):
            page_idx, excerpt = _find_page_excerpt(pages, re.compile(r"(NCT\d{8})", re.IGNORECASE), nct_id)
            signals.append(_make_signal(
                "D4-1", "placeholder_nct_id", "placeholder-registry-id", page_idx, excerpt,
                f"Placeholder ClinicalTrials.gov identifier {nct_id} detected",
                {"nctId": nct_id},
                {"validSyntax": False, "reason": "placeholder_identifier"},
            ))
    return {
        "schema": SCHEMA,
        "identifiers": extracted,
        "signals": signals,
    }


def _call_id_transport(transport, provider, path):
    try:
        result = transport(provider, path)
    except ValueError as error:
        if str(error) == "api_status_404":
            return 404, None, hashlib.sha256(b"").hexdigest(), None
        return None, None, None, str(error)
    except Exception as error:
        return None, None, None, type(error).__name__
    if isinstance(result, tuple) and len(result) == 3:
        return result[0], result[1], result[2], None
    if isinstance(result, tuple) and len(result) == 2:
        return 200, result[0], result[1], None
    return None, None, None, "transport_shape_invalid"


def _parse_osf_payload(data, default_reg):
    obj = (data or {}).get("data") if isinstance(data, dict) else None
    attrs = obj.get("attributes") if isinstance(obj, dict) and isinstance(obj.get("attributes"), dict) else {}
    dtype = str(obj.get("type") or "") if isinstance(obj, dict) else ""
    is_reg = bool(attrs.get("registration")) or dtype == "registrations" or default_reg
    return {
        "title": str(attrs.get("title") or "").strip()[:300],
        "isRegistration": is_reg,
        "kind": "registration" if is_reg else "node",
    }


def _verify_one_osf(osf_id, transport, budget):
    retrieved_at = datetime.now(timezone.utc).isoformat()
    if budget[0] <= 0:
        return None, None, True
    budget[0] -= 1
    st_node, data_node, sha_node, err_node = _call_id_transport(transport, "osf", f"/v2/nodes/{osf_id}/")
    if st_node == 200 and isinstance(data_node, dict):
        parsed = _parse_osf_payload(data_node, False)
        return {"type": "osf", "id": osf_id, "status": "verified", **parsed, "responseSha256": sha_node, "retrievedAt": retrieved_at}, None, False
    if st_node != 404:
        return {"type": "osf", "id": osf_id, "status": "lookup_failed", "errorCode": err_node or f"api_status_{st_node}", "retrievedAt": retrieved_at}, None, False
    if budget[0] <= 0:
        return {"type": "osf", "id": osf_id, "status": "lookup_failed", "errorCode": "lookup_budget_exhausted", "retrievedAt": retrieved_at}, None, True
    budget[0] -= 1
    st_reg, data_reg, sha_reg, err_reg = _call_id_transport(transport, "osf", f"/v2/registrations/{osf_id}/")
    if st_reg == 200 and isinstance(data_reg, dict):
        parsed = _parse_osf_payload(data_reg, True)
        return {"type": "osf", "id": osf_id, "status": "verified", **parsed, "responseSha256": sha_reg, "retrievedAt": retrieved_at}, None, False
    if st_reg == 404:
        sig = _make_signal(
            "D4-1", "unresolved_osf_id", "unresolved-registry-id", 0, f"osf.io/{osf_id}",
            f"OSF identifier osf.io/{osf_id} returned 404 on nodes and registrations endpoints. {TRUTHFULNESS_NOTE}",
            {"osfId": osf_id},
            {"nodesHttpStatus": 404, "registrationsHttpStatus": 404},
        )
        chk = {"type": "osf", "id": osf_id, "status": "not_found", "httpStatus": 404, "note": TRUTHFULNESS_NOTE, "responseSha256": sha_reg, "retrievedAt": retrieved_at}
        return chk, sig, False
    return {"type": "osf", "id": osf_id, "status": "lookup_failed", "errorCode": err_reg or f"api_status_{st_reg}", "retrievedAt": retrieved_at}, None, False


def _verify_one_geo(geo_id, transport, budget):
    retrieved_at = datetime.now(timezone.utc).isoformat()
    if budget[0] <= 0:
        return None, None, True
    budget[0] -= 1
    path = f"/entrez/eutils/esearch.fcgi?db=gds&term={quote(geo_id, safe='')}%5BACCN%5D&retmode=json"
    status, data, sha, err = _call_id_transport(transport, "ncbi", path)
    if status == 404:
        sig = _make_signal(
            "D2", "unresolved_geo_accession", "unresolved-accession", 0, geo_id,
            f"NCBI GEO accession {geo_id} returned 404. {TRUTHFULNESS_NOTE}",
            {"geoId": geo_id}, {"httpStatus": 404},
        )
        return {"type": "geo", "id": geo_id, "status": "not_found", "httpStatus": 404, "note": TRUTHFULNESS_NOTE, "responseSha256": sha, "retrievedAt": retrieved_at}, sig, False
    esearch = (data or {}).get("esearchresult") if isinstance(data, dict) else None
    count_raw = esearch.get("count") if isinstance(esearch, dict) else None
    if status != 200 or count_raw is None or not str(count_raw).isdigit():
        return {"type": "geo", "id": geo_id, "status": "lookup_failed", "errorCode": err or "api_records_shape", "retrievedAt": retrieved_at}, None, False
    count = int(str(count_raw))
    if count == 0:
        sig = _make_signal(
            "D2", "unresolved_geo_accession", "unresolved-accession", 0, geo_id,
            f"NCBI GEO accession {geo_id} returned esearch count=0. {TRUTHFULNESS_NOTE}",
            {"geoId": geo_id}, {"count": 0},
        )
        return {"type": "geo", "id": geo_id, "status": "not_found", "count": 0, "note": TRUTHFULNESS_NOTE, "responseSha256": sha, "retrievedAt": retrieved_at}, sig, False
    id_list = [str(x) for x in (esearch.get("idlist") or [])[:5]]
    return {"type": "geo", "id": geo_id, "status": "verified", "count": count, "idList": id_list, "responseSha256": sha, "retrievedAt": retrieved_at}, None, False


def _verify_one_pdb(pdb_id, transport, budget):
    retrieved_at = datetime.now(timezone.utc).isoformat()
    if budget[0] <= 0:
        return None, None, True
    budget[0] -= 1
    path = f"/rest/v1/core/entry/{quote(pdb_id, safe='')}"
    status, data, sha, err = _call_id_transport(transport, "rcsb", path)
    if status == 404:
        sig = _make_signal(
            "D2", "unresolved_pdb_accession", "unresolved-accession", 0, f"PDB ID: {pdb_id}",
            f"RCSB PDB accession {pdb_id} returned 404. {TRUTHFULNESS_NOTE}",
            {"pdbId": pdb_id}, {"httpStatus": 404},
        )
        return {"type": "pdb", "id": pdb_id, "status": "not_found", "httpStatus": 404, "note": TRUTHFULNESS_NOTE, "responseSha256": sha, "retrievedAt": retrieved_at}, sig, False
    if status != 200 or not isinstance(data, dict):
        return {"type": "pdb", "id": pdb_id, "status": "lookup_failed", "errorCode": err or f"api_status_{status}", "retrievedAt": retrieved_at}, None, False
    struct = data.get("struct") if isinstance(data.get("struct"), dict) else {}
    title = str(struct.get("title") or "").strip()[:300]
    return {"type": "pdb", "id": pdb_id, "status": "verified", "title": title, "responseSha256": sha, "retrievedAt": retrieved_at}, None, False


def _build_online_summary(checks):
    summary = {
        "osfChecked": 0, "osfVerified": 0, "osfUnresolved": 0,
        "geoChecked": 0, "geoVerified": 0, "geoUnresolved": 0,
        "pdbChecked": 0, "pdbVerified": 0, "pdbUnresolved": 0,
        "prosperoChecked": 0, "lookupFailed": 0,
    }
    for chk in checks:
        kind, st = chk["type"], chk["status"]
        if kind == "prospero":
            summary["prosperoChecked"] += 1
            continue
        summary[f"{kind}Checked"] += 1
        if st == "verified":
            summary[f"{kind}Verified"] += 1
        elif st == "not_found":
            summary[f"{kind}Unresolved"] += 1
        elif st == "lookup_failed":
            summary["lookupFailed"] += 1
    return summary


def _run_online_id_checks(extracted, active_transport, budget):
    checks, signals, truncated = [], [], False
    runners = (("osf", _verify_one_osf), ("geo", _verify_one_geo), ("pdb", _verify_one_pdb))
    for key, fn in runners:
        for ident in extracted.get(key) or []:
            chk, sig, hit_limit = fn(ident, active_transport, budget)
            if hit_limit:
                truncated = True
            if chk is not None:
                checks.append(chk)
            if sig is not None:
                signals.append(sig)
    for crd_id in extracted.get("prospero") or []:
        valid = is_valid_prospero_id(crd_id)
        checks.append({
            "type": "prospero",
            "id": crd_id,
            "validSyntax": valid,
            "status": "syntax_verified_no_public_api" if valid else "malformed_syntax",
            "note": PROSPERO_NOTE,
        })
    return checks, signals, truncated


def _online_overall_status(checks, summary):
    if not checks:
        return "empty"
    net_checks = [c for c in checks if c["type"] != "prospero"]
    if not net_checks or summary["lookupFailed"] < len(net_checks):
        return "completed"
    return "failed"


def verify_identifiers_online(extracted, *, transport=None, max_lookups=12):
    """P2 bounded HTTPS verification for OSF, GEO, and PDB identifiers, plus truthful PROSPERO status."""
    if type(max_lookups) is not int or not 1 <= max_lookups <= MAX_LOOKUPS_LIMIT:
        raise ValueError("max_lookups_bound")
    if isinstance(extracted, str):
        extracted = extract_scientific_identifiers(extracted)
    if not isinstance(extracted, dict):
        raise ValueError("extracted_invalid")
    active_transport = fetch_identifier_json if transport is None else transport
    checks, signals, truncated = _run_online_id_checks(extracted, active_transport, [max_lookups])
    summary = _build_online_summary(checks)
    return {
        "schema": SCHEMA,
        "status": _online_overall_status(checks, summary),
        "checkedCount": len(checks),
        "truncated": truncated,
        "summary": summary,
        "checks": checks,
        "signals": signals,
        "limitations": TRUTHFULNESS_NOTE,
    }
