"""Pure-Python deterministic cross-document audit for main paper vs supplementary/code/log files."""
import math
import re

from paper_stat_math import check_count_percentage

SCHEMA = "falsify.paper-supplement-audit.v1"

_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})

_PERCENT_METRICS = frozenset({
    "accuracy", "precision", "sensitivity", "specificity", "f1", "auc", "auroc", "auprc", "r2",
})

_METRIC_ALIASES = {
    "accuracy": "accuracy", "acc": "accuracy", "정확도": "accuracy",
    "auc": "auc", "auroc": "auc", "rocauc": "auc", "cindex": "auc",
    "auprc": "auprc", "prauc": "auprc",
    "f1": "f1", "f1score": "f1",
    "precision": "precision", "정밀도": "precision",
    "recall": "sensitivity", "sensitivity": "sensitivity", "민감도": "sensitivity", "재현율": "sensitivity",
    "specificity": "specificity", "특이도": "specificity",
    "r2": "r2", "r²": "r2",
    "p": "p", "pval": "p", "pvalue": "p",
}

_S_ITEM_SPECS = (
    ("table", re.compile(r"\b(?:Supplementary|Supplemental|Supp\.?|Supporting|Extended\s+Data)\s+(?:Tables?|Tabs?\.?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b", re.IGNORECASE)),
    ("table", re.compile(r"\b(?:Tables?|Tabs?\.?|eTables?)\s+(S\d+[a-z]?)(?:\s*[-–—]\s*(S\d+))?\b", re.IGNORECASE)),
    ("table", re.compile(r"보충\s*표\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—~]\s*(?:S\s*)?(\d+))?")),
    ("figure", re.compile(r"\b(?:Supplementary|Supplemental|Supp\.?|Supporting|Extended\s+Data)\s+(?:Figures?|Figs?\.?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b", re.IGNORECASE)),
    ("figure", re.compile(r"\b(?:Figures?|Figs?\.?|eFigures?|eFigs?\.?)\s+(S\d+[a-z]?)(?:\s*[-–—]\s*(S\d+))?\b", re.IGNORECASE)),
    ("figure", re.compile(r"보충\s*(?:그림|도표)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—~]\s*(?:S\s*)?(\d+))?")),
    ("data", re.compile(r"\b(?:Supplementary|Supplemental|Supp\.?|Supporting)\s+(?:Data|Datasets?|Files?)\s*(?:S\s*)?(\d+[a-z]?)(?:\s*[-–—]\s*(?:S\s*)?(\d+))?\b", re.IGNORECASE)),
    ("data", re.compile(r"\bData\s+(S\d+[a-z]?)\b", re.IGNORECASE)),
    ("data", re.compile(r"보충\s*(?:자료|데이터)\s*(?:S\s*)?(\d+[a-z]?)")),
    ("note", re.compile(r"\b(?:Supplementary|Supplemental|Supp\.?|Supporting)\s+(?:Notes?|Methods?|Text)\s*(?:S\s*)?(\d+[a-z]?)\b", re.IGNORECASE)),
    ("note", re.compile(r"\b(?:Notes?|Methods?)\s+(S\d+[a-z]?)\b", re.IGNORECASE)),
    ("appendix_table", re.compile(r"\bAppendix\s+(?:Table|Tab\.?)\s*([A-Z](?![a-z])|\d+)\b")),
    ("appendix_table", re.compile(r"부록\s*표\s*([A-Z]|\d+)")),
    ("appendix", re.compile(r"\bAppendix\s+([A-Z](?![a-z])|\d+)\b")),
    ("appendix", re.compile(r"부록\s*([A-Z](?![a-z])|\d+)")),
)

_COHORT_SPECS = (
    ("discovery", re.compile(r"\bdiscovery(?:\s+cohort|\s+set|\s+sample)?\b", re.IGNORECASE)),
    ("validation", re.compile(r"\bvalidation(?:\s+cohort|\s+set|\s+sample)?\b", re.IGNORECASE)),
    ("replication", re.compile(r"\breplication(?:\s+cohort|\s+set)?\b", re.IGNORECASE)),
    ("training", re.compile(r"\btraining(?:\s+cohort|\s+set)?\b", re.IGNORECASE)),
    ("test", re.compile(r"\b(?:test|testing|held[- ]out)(?:\s+cohort|\s+set)?\b", re.IGNORECASE)),
    ("external", re.compile(r"\bexternal(?:\s+cohort|\s+validation)?\b", re.IGNORECASE)),
    ("internal", re.compile(r"\binternal(?:\s+cohort|\s+validation)?\b", re.IGNORECASE)),
)

_SUBGROUP_RE = re.compile(
    r"\b(?:subgroup|sub-group|arm\s*[a-z0-9]?|treatment\s+group|control\s+group|placebo|intervention|"
    r"group\s+[a-z0-9]|per\s+(?:group|arm)|each\s+(?:group|arm)|excluded|dropout|missing|"
    r"lost\s+to\s+follow|subset|stratum|fold\s*\d+)\b|하위군|대조군|실험군|제외",
    re.IGNORECASE,
)
_TOTAL_CUE_RE = re.compile(r"\b(?:total|overall|entire|all)\b|전체|총", re.IGNORECASE)
_COHORT_LETTER_RE = re.compile(r"\bcohort\s+([A-Z0-9])\b", re.IGNORECASE)
_METRIC_RE = re.compile(
    r'(?:"?(accuracy|acc|auroc|auprc|roc[-_ ]?auc|auc|c[- ]?index|f1(?:[-_ ]?score)?|'
    r"precision|recall|sensitivity|specificity|r\^?2|r²|rmse|mae|mse|kappa|"
    r'a?or|a?rr|a?hr|p[-_ ]?val(?:ue)?|\bp\b|정확도|민감도|특이도|정밀도|재현율)"?)'
    r"\s*(=|:|<|<=|>|>=|≤|≥)\s*([-−]?\d*\.?\d+(?:[eE][-−+]?\d+)?)\s*(%)?",
    re.IGNORECASE,
)
_CELL_NUM_RE = re.compile(r"^\s*([-−]?\d*\.?\d+(?:[eE][-−+]?\d+)?)\s*(%)?\s*$")
_N_UPPER_RE = re.compile(r"\bN\s*=\s*(\d{2,7})\b")
_N_TOTAL_RE = re.compile(
    r"(?:total|overall|entire)\s+(?:sample\s+size|cohort|participants?|patients?|subjects?|samples?|mice)?"
    r"\s*(?:of|was|were|:|=)?\s*[Nn]?\s*=?\s*(\d{2,7})\b",
    re.IGNORECASE,
)
_N_UNIT_RE = re.compile(
    r"\bn\s*=\s*(\d{2,7})\s*(?:patients?|participants?|subjects?|individuals?|mice|animals?|samples?|cases?|명|마리|건)(?![A-Za-z0-9가-힣])"
)
_N_KO_RE = re.compile(r"(?:전체|총)\s*(?:표본|대상자|환자|참여자|샘플|검체|마리|건)?\s*(?:수)?\s*(?:[Nn]\s*=|:)?\s*(\d{2,7})\s*(?:명|마리|개|건)?")
_N_LOG_KEY_RE = re.compile(
    r'"?(?:total_samples|sample_size|sampleSize|n_samples|total_rows|num_samples|total_n|nrow)"?\s*[:=]\s*(\d{2,7})\b',
    re.IGNORECASE,
)
_N_LOG_LINE_RE = re.compile(
    r"\b(?:Loaded|Analyzed|Processed|Total\s+(?:rows|samples|subjects|patients)|Dataset\s+shape)\s*[:=(]?\s*(\d{2,7})(?:\s*(?:rows|samples|subjects|patients|records)|\s*,\s*\d+\s*\))",
    re.IGNORECASE,
)
# Supplementary-table arithmetic cues. _TABLE_TOTAL_ROW_RE extends the summary-row
# filter used by _extract_csv_sample_claims ("total|summary|mean|overall").
_TABLE_TOTAL_ROW_RE = re.compile(r"^\s*(?:total|sum|overall|all)\b", re.IGNORECASE)
_TABLE_TOTAL_COL_RE = re.compile(r"^\s*(?:total|sum|overall|all)\b", re.IGNORECASE)
_TABLE_COUNT_HDR_RE = re.compile(
    r"^(?:n|count|no\.?|number|events?|patients?|participants?|subjects?|samples?|cases?|mice|animals?)(?![A-Za-z])",
    re.IGNORECASE,
)
_TABLE_N_RE = re.compile(r"\bN\s*=\s*(\d{2,7})\b")
_TABLE_NUM_RE = re.compile(r"^\s*([-−]?(?:\d{1,3}(?:,\d{3})+|\d*\.?\d+(?:[eE][-−+]?\d+)?))\s*(%)?\s*$")


def _assert_no_red_keys(value):
    if isinstance(value, dict):
        for key, val in value.items():
            if key in _FORBIDDEN_RED_KEYS:
                raise ValueError(f"forbidden_red_key:{key}")
            _assert_no_red_keys(val)
    elif isinstance(value, list):
        for item in value:
            _assert_no_red_keys(item)


def _norm_text(text):
    return str(text or "").replace("−", "-").replace("≤", "<=").replace("≥", ">=")


def _snippet(text, start, end, radius=60):
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    return " ".join(text[lo:hi].split())


def _count_decimals(tok):
    m = re.search(r"\.(\d+)", str(tok or ""))
    return len(m.group(1)) if m else 0


def _safe_float(tok):
    try:
        return float(_norm_text(tok).replace(",", "").strip())
    except ValueError:
        return None


def infer_supplement_kind(name):
    """Infer supplement kind ('table-data', 'code-or-log', or 'supplement-doc') from filename."""
    low = str(name or "").lower()
    if low.endswith((".csv", ".tsv")):
        return "table-data"
    if low.endswith((".py", ".r", ".log", ".json")):
        return "code-or-log"
    return "supplement-doc"


def _name_for_search(name):
    cleaned = re.sub(r"[_-]+", " ", str(name or ""))
    return re.sub(r"\b([Tt]able|[Ff]ig(?:ure)?)\s*S(\d+)", r"\1 S\2", cleaned)


def _format_s_item(kind, tok):
    clean = str(tok or "").strip()
    if kind in ("table", "figure", "data", "note"):
        n = re.sub(r"^s", "", clean, flags=re.IGNORECASE)
        prefixes = {
            "table": ("table:s", "Table S"),
            "figure": ("figure:s", "Figure S"),
            "data": ("data:s", "Supplementary Data "),
            "note": ("note:s", "Supplementary Note "),
        }
        kp, lp = prefixes[kind]
        return {"key": f"{kp}{n.lower()}", "label": f"{lp}{n}"}
    if kind == "appendix_table":
        return {"key": f"appendix-table:{clean.lower()}", "label": f"Appendix Table {clean.upper()}"}
    return {"key": f"appendix:{clean.lower()}", "label": f"Appendix {clean.upper()}"}


def _expand_s_tokens(start_tok, end_tok):
    if not end_tok:
        return [start_tok]
    sa = re.sub(r"^s", "", str(start_tok), flags=re.IGNORECASE)
    sb = re.sub(r"^s", "", str(end_tok), flags=re.IGNORECASE)
    if sa.isdigit() and sb.isdigit():
        a, b = int(sa), int(sb)
        if 0 <= b - a <= 20:
            return [str(k) for k in range(a, b + 1)]
    return [start_tok, end_tok]


def extract_supplementary_items(text):
    """Extract normalized supplementary item references (e.g., Table S1, Appendix B)."""
    hay = str(text or "")
    out = []
    for kind, pattern in _S_ITEM_SPECS:
        for m in pattern.finditer(hay):
            end_tok = m.group(2) if m.lastindex and m.lastindex >= 2 else None
            for tok in _expand_s_tokens(m.group(1), end_tok):
                fmt = _format_s_item(kind, tok)
                out.append({**fmt, "raw": m.group(0), "index": m.start()})
    return out


def _parent_s_key(key):
    m = re.fullmatch(r"([a-z-]+:s\d+)[a-z]", key)
    return m.group(1) if m else None


def _page_index_of(seg, idx):
    if isinstance(seg.get("pageIndex"), int) and seg["pageIndex"] >= 0:
        return seg["pageIndex"]
    m = re.search(r"(?:PDF p\.|p(?:age)?\.?)\s*(\d+)", str(seg.get("label") or ""), re.IGNORECASE)
    return max(0, int(m.group(1)) - 1) if m else idx


def _normalize_segments(raw):
    if isinstance(raw, str):
        return [{"id": "s0", "label": "Main", "text": raw, "pageIndex": 0}] if raw.strip() else []
    if not isinstance(raw, list):
        return []
    out = []
    for idx, item in enumerate(raw):
        if isinstance(item, str) and item.strip():
            out.append({"id": f"s{idx}", "label": f"PDF p. {idx + 1}", "text": item, "pageIndex": idx})
        elif isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip():
            seg_id = str(item.get("id") or f"s{idx}")
            if not seg_id.startswith("supp-"):
                out.append({
                    "id": seg_id,
                    "label": str(item.get("label") or f"Segment {idx + 1}"),
                    "text": item["text"],
                    "pageIndex": _page_index_of(item, idx),
                })
    return out


def _normalize_supplement(supp, idx):
    if not isinstance(supp, dict):
        raise ValueError("supplement_entry_invalid")
    name = str(supp.get("name") or supp.get("filename") or supp.get("fileId") or f"supplement-{idx + 1}")
    kind = supp.get("kind") or infer_supplement_kind(name)
    raw_segs = supp.get("segments") if supp.get("segments") is not None else supp.get("pages")
    segs = _normalize_segments(raw_segs if raw_segs is not None else (supp.get("text") or ""))
    return {"fileId": str(supp.get("fileId") or f"supp-file-{idx}"), "name": name, "kind": kind, "segments": segs}


def _collect_present_items(supps):
    keys, labels = set(), {}
    for supp in supps:
        sources = [_name_for_search(supp["name"])] + [f"{s['label']}\n{s['text']}" for s in supp["segments"]]
        for text in sources:
            for it in extract_supplementary_items(text):
                keys.add(it["key"])
                labels.setdefault(it["key"], it["label"])
                pk = _parent_s_key(it["key"])
                if pk:
                    keys.add(pk)
    return keys, list(labels.values())


def _detect_missing_supplements(main_segs, supps):
    if not supps:
        return [], [], []
    present_keys, present_labels = _collect_present_items(supps)
    cited = {}
    for seg in main_segs:
        for it in extract_supplementary_items(seg["text"]):
            cited.setdefault(it["key"], {**it, "seg": seg})
    supp_names = ", ".join(s["name"] for s in supps[:4])
    signals = []
    for key, it in cited.items():
        if key in present_keys:
            continue
        seg = it["seg"]
        ex = _snippet(seg["text"], it["index"], it["index"] + len(it["raw"]))
        signals.append({
            "family": "D4-1", "category": "D4-1", "kind": "missing_supplementary_item",
            "segmentId": seg["id"], "pageIndex": seg["pageIndex"], "supplementFile": None, "excerpt": ex,
            "detail": f"Main text cites {it['label']}, but attached supplement(s) ({supp_names}) do not define it.",
            "reported": {"item": it["label"], "rawCitation": it["raw"]},
            "computed": {"presentItems": present_labels, "attachedFiles": [s["name"] for s in supps]},
        })
    return [v["label"] for v in cited.values()], present_labels, signals


def _extract_cohort_tag(ctx, file_name):
    hay = f"{ctx or ''} {_name_for_search(file_name)}"
    for tag, pattern in _COHORT_SPECS:
        if pattern.search(hay):
            return tag
    cm = _COHORT_LETTER_RE.search(hay)
    return f"cohort:{cm.group(1).lower()}" if cm else ""


def _scan_sample_regex(text, pattern, claims, seen, meta, guard_subgroup):
    for m in pattern.finditer(text):
        ctx = text[max(0, m.start() - 70):min(len(text), m.end() + 70)]
        if guard_subgroup and _SUBGROUP_RE.search(ctx) and not _TOTAL_CUE_RE.search(ctx):
            continue
        val = int(m.group(1))
        if not 2 <= val <= 10_000_000:
            continue
        tag = _extract_cohort_tag(ctx, meta["fileName"])
        key = f"{meta['fileName']}:{meta['segmentId']}:{val}:{tag}"
        if key in seen:
            continue
        seen.add(key)
        items = extract_supplementary_items(ctx)
        claims.append({
            "value": val, "cohortTag": tag, "anchorKey": items[0]["key"] if items else meta["anchorKey"],
            "segmentId": meta["segmentId"], "pageIndex": meta["pageIndex"],
            "fileName": meta["fileName"], "sourceType": meta["sourceType"],
            "excerpt": _snippet(text, m.start(), m.end()),
        })


def _extract_text_sample_claims(seg, file_name, is_supp, default_anchor):
    text = _norm_text(seg["text"])
    claims, seen = [], set()
    base = {"segmentId": seg["id"], "pageIndex": seg["pageIndex"], "fileName": file_name,
            "anchorKey": default_anchor, "sourceType": "supplement_text" if is_supp else "main_text"}
    _scan_sample_regex(text, _N_UPPER_RE, claims, seen, base, True)
    _scan_sample_regex(text, _N_TOTAL_RE, claims, seen, base, False)
    _scan_sample_regex(text, _N_UNIT_RE, claims, seen, base, True)
    _scan_sample_regex(text, _N_KO_RE, claims, seen, base, False)
    if is_supp:
        log_meta = {**base, "sourceType": "supplement_log"}
        _scan_sample_regex(text, _N_LOG_KEY_RE, claims, seen, log_meta, False)
        _scan_sample_regex(text, _N_LOG_LINE_RE, claims, seen, log_meta, False)
    return claims


def _parse_delimited_rows(text):
    lines = [ln.strip() for ln in str(text or "").splitlines() if ln.strip()]
    if len(lines) < 2:
        return None
    delim = "\t" if "\t" in lines[0] else ("," if "," in lines[0] else None)
    if delim is None:
        return None
    rows = [[c.strip().strip('"') for c in ln.split(delim)] for ln in lines]
    cols = len(rows[0])
    if cols < 2 or not all(len(r) == cols for r in rows[1:4]):
        return None
    return rows


def _looks_like_summary_table(headers):
    joined = " ".join(headers).lower()
    has_entity = bool(re.search(r"\b(?:id|patient|subject|sample|participant|mouse|animal|case|record|specimen)\b", joined))
    has_metric = bool(re.search(r"\b(?:metric|measure|statistic|model|method|parameter|fold|epoch|auc|accuracy)\b", joined))
    return has_metric and not has_entity


def _extract_csv_sample_claims(supp, default_anchor):
    if supp["kind"] != "table-data" or _SUBGROUP_RE.search(_name_for_search(supp["name"])):
        return []
    rows = _parse_delimited_rows("\n".join(s["text"] for s in supp["segments"]))
    if not rows:
        return []
    has_hdr = any(re.search(r"[A-Za-z가-힣]", c) and not re.fullmatch(r"-?\d+(?:\.\d+)?%?", c) for c in rows[0])
    if has_hdr and _looks_like_summary_table(rows[0]):
        return []
    data_rows = [r for r in rows[1 if has_hdr else 0:] if not re.match(r"^(?:total|summary|mean|overall)$", r[0], re.IGNORECASE)]
    if len(data_rows) < 5:
        return []
    return [{
        "value": len(data_rows), "cohortTag": _extract_cohort_tag("", supp["name"]),
        "anchorKey": default_anchor, "segmentId": supp["segments"][0]["id"] if supp["segments"] else "s0",
        "pageIndex": 0, "fileName": supp["name"], "sourceType": "csv_row_count",
        "excerpt": f"{supp['name']} ({len(data_rows)} data rows)",
    }]


def _sample_claims_compatible(mc, sc):
    if mc["anchorKey"] and sc["anchorKey"] and mc["anchorKey"] != sc["anchorKey"]:
        return False
    if mc["cohortTag"] and sc["cohortTag"] and mc["cohortTag"] != sc["cohortTag"]:
        return False
    return True


def _detect_sample_size_mismatches(main_segs, supps):
    main_claims, supp_claims = [], []
    for seg in main_segs:
        main_claims.extend(_extract_text_sample_claims(seg, "main", False, None))
    for supp in supps:
        fn_items = extract_supplementary_items(_name_for_search(supp["name"]))
        def_anchor = fn_items[0]["key"] if fn_items else None
        for seg in supp["segments"]:
            supp_claims.extend(_extract_text_sample_claims(seg, supp["name"], True, def_anchor))
        supp_claims.extend(_extract_csv_sample_claims(supp, def_anchor))
    signals, seen = [], set()
    for mc in main_claims:
        compat = [sc for sc in supp_claims if _sample_claims_compatible(mc, sc)]
        if not compat or any(sc["value"] == mc["value"] for sc in compat):
            continue
        sc = compat[0]
        key = f"{mc['value']}!={sc['value']}:{sc['fileName']}"
        if key in seen:
            continue
        seen.add(key)
        signals.append({
            "family": "D1", "category": "D1", "kind": "cross_file_sample_size_mismatch",
            "segmentId": mc["segmentId"], "pageIndex": mc["pageIndex"], "supplementFile": sc["fileName"],
            "excerpt": mc["excerpt"],
            "detail": f"Main sample size N={mc['value']} conflicts with {sc['fileName']} ({sc['value']}).",
            "reported": {"mainN": mc["value"], "cohort": mc["cohortTag"] or None, "mainExcerpt": mc["excerpt"]},
            "computed": {"supplementN": sc["value"], "sourceType": sc["sourceType"], "supplementFile": sc["fileName"], "supplementExcerpt": sc["excerpt"]},
        })
    return signals


def _canonical_metric_key(raw):
    k = re.sub(r"[^a-z0-9가-힣²]+", "", str(raw or "").lower())
    return _METRIC_ALIASES.get(k, k)


def _extract_metrics_from_text(text, meta):
    norm = _norm_text(text)
    out = []
    for m in _METRIC_RE.finditer(norm):
        val = _safe_float(m.group(3))
        if val is None:
            continue
        out.append({
            "metricKey": _canonical_metric_key(m.group(1)),
            "op": m.group(2), "value": val, "isPercent": bool(m.group(4)),
            "decimals": _count_decimals(m.group(3)),
            "anchorKey": meta.get("anchorKey"), "suppKind": meta.get("suppKind"),
            "fileName": meta.get("fileName"), "segmentId": meta["segmentId"],
            "pageIndex": meta["pageIndex"], "excerpt": _snippet(norm, m.start(), m.end()),
        })
    return out


def _extract_main_metric_claims(main_segs):
    claims = []
    for seg in main_segs:
        for sent in re.split(r"(?<=[.!?])\s+|\r?\n+", str(seg["text"] or "")):
            items = extract_supplementary_items(sent)
            anchor = items[0]["key"] if items else None
            claims.extend(_extract_metrics_from_text(sent, {"anchorKey": anchor, "segmentId": seg["id"], "pageIndex": seg["pageIndex"], "fileName": "main"}))
    return claims


def _parse_cell_metric_value(raw):
    m = _CELL_NUM_RE.match(_norm_text(raw))
    if not m:
        return None
    val = _safe_float(m.group(1))
    return None if val is None else {"value": val, "isPercent": bool(m.group(2)), "decimals": _count_decimals(m.group(1))}


def _extract_csv_metric_claims(supp, default_anchor):
    if supp["kind"] != "table-data":
        return []
    rows = _parse_delimited_rows("\n".join(s["text"] for s in supp["segments"]))
    if not rows or len(rows) < 2:
        return []
    headers = [_canonical_metric_key(h) for h in rows[0]]
    out = []
    for row in rows[1:]:
        ex = ", ".join(row)[:140]
        base = {"op": "=", "anchorKey": default_anchor, "suppKind": supp["kind"], "fileName": supp["name"], "segmentId": "s0", "pageIndex": 0, "excerpt": ex}
        for col_idx, h_key in enumerate(headers):
            parsed = _parse_cell_metric_value(row[col_idx]) if h_key else None
            if parsed:
                out.append({"metricKey": h_key, **parsed, **base})
        if len(row) >= 2:
            kv_key, kv_val = _canonical_metric_key(row[0]), _parse_cell_metric_value(row[1])
            if kv_key and kv_val:
                out.append({"metricKey": kv_key, **kv_val, **base})
    return out


def _parse_table_cell(raw):
    """Return {'value','decimals','isPercent'} for an unambiguous numeric cell, else None."""
    m = _TABLE_NUM_RE.match(str(raw or ""))
    if not m:
        return None
    value = _safe_float(m.group(1))
    if value is None:
        return None
    return {"value": value, "decimals": _count_decimals(m.group(1)), "isPercent": bool(m.group(2))}


def _table_row_cells(row):
    return [_parse_table_cell(cell) for cell in row]


def _table_has_header(rows):
    first = rows[0] if rows else []
    letters = any(re.search(r"[A-Za-z가-힣]", str(cell or "")) for cell in first)
    numeric = sum(1 for cell in first if _parse_table_cell(cell) is not None)
    return bool(letters) and numeric < len(first)


def _table_sum_matches(cell, total):
    tolerance = 0.5 * (10.0 ** (-cell["decimals"])) + 1e-9
    return abs(cell["value"] - total) <= tolerance


def _column_values_above(cells_rows, start_row, end_row, column):
    values = []
    for row_index in range(start_row, end_row):
        row = cells_rows[row_index]
        cell = row[column] if column < len(row) else None
        if not cell or cell["isPercent"]:
            return None
        values.append(cell["value"])
    return values if len(values) >= 2 else None


def _row_values(cells_row, exclude_column):
    values = []
    for column, cell in enumerate(cells_row):
        if column == 0 or column == exclude_column:
            continue
        if not cell or cell["isPercent"]:
            return None
        values.append(cell["value"])
    return values if len(values) >= 2 else None


def _table_sum_signal(block, label, header, cell, total, cell_count, excerpt, meta):
    return {
        "family": "D1", "category": "D1", "kind": "supplement_table_sum_mismatch",
        "segmentId": meta["segmentId"], "pageIndex": meta["pageIndex"], "supplementFile": meta["fileName"],
        "excerpt": excerpt,
        "reported": {
            "table": block, "label": label, "column": header,
            "printed": cell["value"], "decimals": cell["decimals"],
        },
        "computed": {
            "sum": round(total, 6), "cellCount": cell_count,
            "supplementFile": meta["fileName"], "segmentId": meta["segmentId"],
        },
        "detail": (
            f"{block} row '{label}' prints {cell['value']} in column '{header}', "
            f"but the {cell_count} cells above sum to {round(total, 6)}."
        ),
    }


def _column_header(rows, column):
    header = rows[0][column] if column < len(rows[0]) else ""
    return str(header or f"col{column + 1}")


def _row_sum_signals(rows, meta):
    has_header = _table_has_header(rows)
    cells_rows = [_table_row_cells(row) for row in rows]
    start = 1 if has_header else 0
    signals = []
    for row_index in range(start, len(rows)):
        if not _TABLE_TOTAL_ROW_RE.match(str(rows[row_index][0] or "")):
            continue
        for column in range(1, len(rows[row_index])):
            cell = cells_rows[row_index][column]
            if not cell or cell["isPercent"]:
                continue
            values = _column_values_above(cells_rows, start, row_index, column)
            if values is None:
                continue
            total = math.fsum(values)
            if _table_sum_matches(cell, total):
                continue
            signals.append(_table_sum_signal(
                "row-sum", rows[row_index][0], _column_header(rows, column),
                cell, total, len(values), ", ".join(rows[row_index])[:140], meta,
            ))
    return signals


def _column_sum_row_signal(rows, cells_rows, row_index, column, meta):
    cell = cells_rows[row_index][column] if column < len(cells_rows[row_index]) else None
    if not cell or cell["isPercent"]:
        return None
    values = _row_values(cells_rows[row_index], column)
    if values is None:
        return None
    total = math.fsum(values)
    if _table_sum_matches(cell, total):
        return None
    return _table_sum_signal(
        "column-sum", rows[row_index][0], _column_header(rows, column),
        cell, total, len(values), ", ".join(rows[row_index])[:140], meta,
    )


def _column_sum_signals(rows, meta):
    if not _table_has_header(rows):
        return []
    cells_rows = [_table_row_cells(row) for row in rows]
    total_columns = [col for col, head in enumerate(rows[0]) if col > 0 and _TABLE_TOTAL_COL_RE.match(str(head or ""))]
    signals = []
    for column in total_columns:
        for row_index in range(1, len(rows)):
            if _TABLE_TOTAL_ROW_RE.match(str(rows[row_index][0] or "")):
                continue
            signal = _column_sum_row_signal(rows, cells_rows, row_index, column, meta)
            if signal is not None:
                signals.append(signal)
    return signals


def _table_total_for_column(rows, cells_rows, column):
    for row_index, row in enumerate(rows):
        if not _TABLE_TOTAL_ROW_RE.match(str(row[0] or "")):
            continue
        cell = cells_rows[row_index][column] if column < len(cells_rows[row_index]) else None
        if not cell or cell["isPercent"] or cell["value"] <= 0 or cell["value"] != int(cell["value"]):
            continue
        return int(cell["value"])
    return None


def _table_percentage_signal(label, header, cell, count, total, check, excerpt, meta):
    return {
        "family": "D1", "category": "D1", "kind": "supplement_table_percentage_mismatch",
        "segmentId": meta["segmentId"], "pageIndex": meta["pageIndex"], "supplementFile": meta["fileName"],
        "excerpt": excerpt,
        "reported": {
            "table": "percentage", "label": label, "column": header,
            "printedPct": cell["value"], "decimals": cell["decimals"], "count": count, "total": total,
        },
        "computed": {
            "computedPct": round(check["computedPct"], 6), "diffPctPoints": round(check["diffPctPoints"], 6),
            "status": check["status"], "supplementFile": meta["fileName"], "segmentId": meta["segmentId"],
        },
        "detail": (
            f"Row '{label}' prints {cell['value']}% for column '{header}', "
            f"but {count}/{total} computes to {round(check['computedPct'], 6)}%."
        ),
    }


def _row_percentage_signals(rows, cells_rows, row_index, count_columns, header_n, meta):
    row_label = str(rows[row_index][0] or "")
    signals = []
    for count_column in count_columns:
        count_cell = cells_rows[row_index][count_column]
        if not count_cell or count_cell["isPercent"] or count_cell["value"] <= 0:
            continue
        if count_cell["value"] != int(count_cell["value"]):
            continue
        count = int(count_cell["value"])
        total = header_n or _table_total_for_column(rows, cells_rows, count_column)
        if not total or total < count:
            continue
        for column, cell in enumerate(cells_rows[row_index]):
            if not cell or not cell["isPercent"]:
                continue
            check = check_count_percentage(count, total, cell["value"], cell["decimals"])
            if check["consistent"]:
                continue
            signals.append(_table_percentage_signal(
                row_label, _column_header(rows, column), cell, count, total, check,
                ", ".join(rows[row_index])[:140], meta,
            ))
    return signals


def _percentage_signals(rows, meta):
    if not _table_has_header(rows):
        return []
    count_columns = [
        column for column, head in enumerate(rows[0])
        if column > 0 and _TABLE_COUNT_HDR_RE.match(_norm_text(head).strip())
    ]
    if not count_columns:
        return []
    cells_rows = [_table_row_cells(row) for row in rows]
    header_n = _TABLE_N_RE.search(" ".join(str(head or "") for head in rows[0]))
    stated_n = int(header_n.group(1)) if header_n else None
    signals = []
    for row_index in range(1, len(rows)):
        if _TABLE_TOTAL_ROW_RE.match(str(rows[row_index][0] or "")):
            continue
        signals.extend(_row_percentage_signals(rows, cells_rows, row_index, count_columns, stated_n, meta))
    return signals


def _table_text_blocks(supp):
    if supp["kind"] == "table-data":
        text = "\n".join(seg["text"] for seg in supp["segments"])
        first = supp["segments"][0] if supp["segments"] else {"id": "s0", "pageIndex": 0}
        return [(text, {"segmentId": first["id"], "pageIndex": first.get("pageIndex", 0), "fileName": supp["name"]})]
    return [
        (seg["text"], {"segmentId": seg["id"], "pageIndex": seg["pageIndex"], "fileName": supp["name"]})
        for seg in supp["segments"]
    ]


def _detect_supplement_table_arithmetic(supplements):
    """Deterministic arithmetic audit of supplementary tables (row/column sums, percentage vs N)."""
    signals = []
    for supp in supplements:
        for text, meta in _table_text_blocks(supp):
            rows = _parse_delimited_rows(text)
            if not rows or len(rows) < 3 or not _table_has_header(rows):
                continue
            signals.extend(_row_sum_signals(rows, meta))
            signals.extend(_column_sum_signals(rows, meta))
            signals.extend(_percentage_signals(rows, meta))
    return signals


def _extract_supplement_metrics(supps):
    claims = []
    for supp in supps:
        fn_items = extract_supplementary_items(_name_for_search(supp["name"]))
        active_anchor = fn_items[0]["key"] if fn_items else None
        for seg in supp["segments"]:
            for line in str(seg["text"] or "").splitlines():
                found = extract_supplementary_items(line)
                if found:
                    active_anchor = found[0]["key"]
                claims.extend(_extract_metrics_from_text(line, {"anchorKey": active_anchor, "suppKind": supp["kind"], "fileName": supp["name"], "segmentId": seg["id"], "pageIndex": seg["pageIndex"]}))
        claims.extend(_extract_csv_metric_claims(supp, fn_items[0]["key"] if fn_items else None))
    return claims


def _scaled_metric_pair(a, b):
    va, da, vb, db = a["value"], a["decimals"], b["value"], b["decimals"]
    if a["isPercent"] != b["isPercent"] and a["metricKey"] in _PERCENT_METRICS:
        if not a["isPercent"] and 0.0 <= va <= 1.000001:
            va *= 100.0
            da = max(0, da - 2)
        elif not b["isPercent"] and 0.0 <= vb <= 1.000001:
            vb *= 100.0
            db = max(0, db - 2)
    return va, da, vb, db


def _metrics_consistent(a, b):
    va, da, vb, db = _scaled_metric_pair(a, b)
    tol = 0.5 * (10.0 ** (-min(da, db))) + 1e-6
    if a["op"] == "<" and b["op"] == "=":
        return vb < va + tol
    if a["op"] == "<=" and b["op"] == "=":
        return vb <= va + tol
    if a["op"] == ">" and b["op"] == "=":
        return vb > va - tol
    if a["op"] == ">=" and b["op"] == "=":
        return vb >= va - tol
    if b["op"] == "<" and a["op"] == "=":
        return va < vb + tol
    if b["op"] == "<=" and a["op"] == "=":
        return va <= vb + tol
    return abs(va - vb) <= tol


def _detect_metric_mismatches(main_segs, supps):
    main_claims = _extract_main_metric_claims(main_segs)
    supp_claims = _extract_supplement_metrics(supps)
    signals, seen = [], set()
    for mc in main_claims:
        cands = [sc for sc in supp_claims if sc["metricKey"] == mc["metricKey"] and (sc["anchorKey"] == mc["anchorKey"] if mc["anchorKey"] else sc["suppKind"] == "code-or-log")]
        if not cands or any(_metrics_consistent(mc, sc) for sc in cands):
            continue
        sc = cands[0]
        dedup = f"{mc['metricKey']}:{mc['anchorKey'] or 'log'}:{mc['value']}!={sc['value']}:{sc['fileName']}"
        if dedup in seen:
            continue
        seen.add(dedup)
        loc = mc["anchorKey"].replace(":", " ").upper() if mc["anchorKey"] else sc["fileName"]
        signals.append({
            "family": "D1", "category": "D1", "kind": "cross_file_metric_mismatch",
            "segmentId": mc["segmentId"], "pageIndex": mc["pageIndex"], "supplementFile": sc["fileName"],
            "excerpt": mc["excerpt"],
            "detail": f"Main {mc['metricKey']}={mc['value']}{'%' if mc['isPercent'] else ''} ({loc}) conflicts with {sc['fileName']} ({sc['value']}{'%' if sc['isPercent'] else ''}).",
            "reported": {"metric": mc["metricKey"], "anchor": mc["anchorKey"], "value": mc["value"], "operator": mc["op"], "isPercent": mc["isPercent"]},
            "computed": {"supplementValue": sc["value"], "operator": sc["op"], "isPercent": sc["isPercent"], "supplementFile": sc["fileName"], "supplementExcerpt": sc["excerpt"]},
        })
    return signals


def _count_signals(signals):
    by_kind = {
        "missing_supplementary_item": 0,
        "cross_file_sample_size_mismatch": 0,
        "cross_file_metric_mismatch": 0,
        "supplement_table_sum_mismatch": 0,
        "supplement_table_percentage_mismatch": 0,
    }
    d1, d4_1 = 0, 0
    for sig in signals:
        if sig["family"] == "D1":
            d1 += 1
        elif sig["family"] == "D4-1":
            d4_1 += 1
        if sig["kind"] in by_kind:
            by_kind[sig["kind"]] += 1
    return {"total": len(signals), "d1": d1, "d4_1": d4_1, "byKind": by_kind}


def audit_paper_with_supplements(main_text_or_pages, supplements):
    """Deterministically cross-audit main paper text/pages against attached supplement docs, tables, code, and logs."""
    _assert_no_red_keys(main_text_or_pages)
    _assert_no_red_keys(supplements)
    main_segs = _normalize_segments(main_text_or_pages)
    norm_supps = [_normalize_supplement(s, i) for i, s in enumerate(supplements or [])]
    cited_items, present_items, miss_sigs = _detect_missing_supplements(main_segs, norm_supps)
    n_sigs = _detect_sample_size_mismatches(main_segs, norm_supps)
    metric_sigs = _detect_metric_mismatches(main_segs, norm_supps)
    table_sigs = _detect_supplement_table_arithmetic(norm_supps)
    signals = [{**sig, "id": f"SUPP-{i + 1}"} for i, sig in enumerate(miss_sigs + n_sigs + metric_sigs + table_sigs)]
    report = {
        "schema": SCHEMA,
        "supplementCount": len(norm_supps),
        "citedItems": cited_items,
        "presentItems": present_items,
        "signals": signals,
        "counts": _count_signals(signals),
    }
    _assert_no_red_keys(report)
    return report
