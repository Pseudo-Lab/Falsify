"""Participant-flow arithmetic and separated semantic spin-triage hints.

Deterministic D1 defects are returned as ``signals``. D3 causal overclaim and
S1 polarity inversion need a later reading, so they are ``triageHints`` only.
"""
import json
import re

SCHEMA = "falsify.flow-spin-triage.v1"
_FORBIDDEN = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})

_SCREENED_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects|individuals|people)\s+)?"
    r"(?:(?:were|was)\s+)?(?:screened|assessed\s+for\s+eligibility)\b",
    re.I,
)
_EXCLUDED_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects)\s+)?(?:(?:were|was)\s+)?"
    r"(?:excluded\s+before\s+randomization|did\s+not\s+meet(?:\s+the)?(?:\s+inclusion)?\s+criteria)\b",
    re.I,
)
_RANDOMIZED_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects|individuals|people)\s+)?"
    r"(?:(?:were|was)\s+)?(?<!-)randomized\b",
    re.I,
)
_ENROLLED_COUNT_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects)\s+)?(?:(?:were|was)\s+)?enrolled\b",
    re.I,
)
_ENROLLED_N_RE = re.compile(r"\benrolled\s+N\s*=\s*(\d+)\b", re.I)
_LOSS_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects)\s+)?(?:(?:were|was|had)\s+)?"
    r"(?:discontinued|lost\s+to\s+follow-up|withdrew|withdrawn|excluded\s+from\s+analysis)\b",
    re.I,
)
_END_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects)\s+)?(?:(?:were|was)\s+)?"
    r"(?:analyzed|analysed|completed)\b",
    re.I,
)
_ARM_PAREN_RE = re.compile(
    r"(?<!\d)(\d+)\s+(?:(?:patients|participants|subjects|individuals|people)\s+)?"
    r"(?:were|was)\s+randomized\s*\(([^)]*)\)",
    re.I,
)
_ARM_TOKEN_RE = re.compile(r"(?<!\d)(\d+)\s+[A-Za-z]")
_ASSIGNED_RE = re.compile(r"(?<!\d)(\d+)\s+assigned\s+to\s+[A-Za-z]", re.I)
_FRAC_RE = re.compile(r"(?<!\d)(\d{1,6})\s*/\s*(\d{1,6})(?!\d)")
_DATE_RE = re.compile(
    r"\b(?:(?:19|20)\d{2}/\d{1,2}(?:/\d{1,2})?|\d{1,2}/\d{1,2}/(?:19|20)\d{2})\b"
)
_RATIO_RE = re.compile(
    r"mm\s*hg|blood pressure|\bvisual acuity\b|\b(?:hazard|odds)\s+ratio\b",
    re.I,
)
_ABBREV_RATIO_RE = re.compile(r"\b(?:HR|OR)\b")
_CITE_RE = re.compile(r"\bet al\.?", re.I)
_CLINICAL_RE = re.compile(r"\b(?:events?|patients?|responders?|participants?)\b", re.I)
_PCT_AFTER_RE = re.compile(r"\(\s*\d+(?:\.\d+)?\s*%\s*\)")
_N_RE = re.compile(r"\b[Nn]\s*=\s*(\d+)\b")
_LEADING_INT_RE = re.compile(r"\s*(\d+)\b")
_MISSING_LABEL_RE = re.compile(
    r"^(?:missing|unknown|not reported|not available|other)$",
    re.I,
)
_MISSING_NOTE_RE = re.compile(
    r"missing|unknown|not available|complete data|available\s+n",
    re.I,
)
_MULTI_RE = re.compile(
    r"non-mutually exclusive|multiple conditions|more than one|could have multiple",
    re.I,
)
_YN_RE = re.compile(r"^(?:(.+?)[\s:-]+)?(yes|no)$", re.I)
_DESIGN_RE = re.compile(
    r"single-arm|observational|retrospective|cross-sectional|case series|"
    r"no randomization|non-randomized|nonrandomized|\bmurine\b|\bmice\b|in vitro|\bpreclinical\b",
    re.I,
)
_P_RE = re.compile(r"\bp\s*(<=|>=|[<>=≤≥])\s*(\d*\.\d+|\d+)\b", re.I)
_NONSIG_RE = re.compile(r"non-?significant|not significant", re.I)
_CAUSAL_RE = re.compile(
    r"\bcausally\b|\bproves that\b|\bestablishes causality\b|\beliminates mortality\b",
    re.I,
)
_EXEMPT_RE = re.compile(
    r"\bmay\b|\bmight\b|associated with|warrants further randomized trials|"
    r"exploratory|hypothesis-generating",
    re.I,
)
_NUM_ARM_RE = re.compile(
    r"\btreatment\s+(?P<metric>[a-z][a-z\s]{0,48}?)\s+was\s+(?P<tv>\d+(?:\.\d+)?)%\s+"
    r"and\s+control\s+[a-z][a-z\s]{0,48}?\s+was\s+(?P<cv>\d+(?:\.\d+)?)%",
    re.I,
)
_NUM_VS_RE = re.compile(
    r"\b(?P<metric>[a-z][a-z\s]{0,48}?)\s+was\s+(?P<tv>\d+(?:\.\d+)?)%\s+in\s+treatment\s+"
    r"vs\.?\s+(?P<cv>\d+(?:\.\d+)?)%\s+in\s+control\b",
    re.I,
)
_ABBREV_DOT_RE = re.compile(r"\b(?:et al|vs|fig|dr|mr|mrs|prof|no|vol)\.", re.I)
_CLAIM_RE = re.compile(
    r"\btreatment\b.{0,120}?\b(?P<direction>reduced|lowered|decreased|increased|raised)\b"
    r".{0,120}?\b(?:relative to|compared with|compared to)\b.{0,80}?\bcontrol\b",
    re.I | re.S,
)
_SEX_PAIRS = (
    ("male", "female", "male+female"),
    ("men", "women", "men+women"),
)


def _require_limit(value):
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= 100:
        raise ValueError("limit")


def _reject_red_keys(obj):
    if isinstance(obj, dict):
        _reject_red_dict(obj)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            _reject_red_keys(item)


def _reject_red_dict(obj):
    for key, val in obj.items():
        if key in _FORBIDDEN:
            raise ValueError("forbidden_red_key")
        _reject_red_keys(val)


def _clip(text):
    return " ".join(str(text or "").split())[:220]


def _stable(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)


def _first_int(pattern, text):
    match = pattern.search(text)
    if match is None:
        return None
    return int(match.group(1))


def _sum_groups(pattern, text):
    values = [int(match.group(1)) for match in pattern.finditer(text)]
    if not values:
        return None
    return sum(values)


def _cohort_base(text):
    randomized = _first_int(_RANDOMIZED_RE, text)
    if randomized is not None:
        return randomized
    enrolled = _first_int(_ENROLLED_COUNT_RE, text)
    if enrolled is not None:
        return enrolled
    return _first_int(_ENROLLED_N_RE, text)


def _flow_signal(kind, subtype, page_index, excerpt, detail, reported, computed, item_id=None):
    sig = {
        "family": "D1",
        "kind": kind,
        "subtype": subtype,
        "pageIndex": page_index,
        "excerpt": _clip(excerpt),
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }
    if item_id is not None:
        sig["itemId"] = item_id
    return sig


def _consort(page_index, text, item_id, detail, reported, computed):
    return [_flow_signal(
        "consort_flow_mismatch", "participant-flow-mismatch",
        page_index, text, detail, reported, computed, item_id,
    )]


def _hint(family, kind, subtype, page_index, excerpt, detail, reported, computed):
    return {
        "family": family,
        "kind": kind,
        "subtype": subtype,
        "advisoryOnly": True,
        "pageIndex": page_index,
        "excerpt": _clip(excerpt),
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }


def _protect_abbreviations(text):
    return _ABBREV_DOT_RE.sub(lambda match: match.group(0)[:-1] + "\u0000", text)


def _sentences(text):
    flat = " ".join(re.sub(r"\s*\n\s*", " ", text or "").split())
    if not flat:
        return []
    protected = _protect_abbreviations(flat)
    parts = re.split(r"(?<=[.!?])\s+", protected)
    return [part.replace("\u0000", ".").strip() for part in parts if part.strip()]


def _page_index_of(item, fallback):
    page_index = item.get("pageIndex", fallback) if isinstance(item, dict) else fallback
    if type(page_index) is not int or isinstance(page_index, bool):
        return fallback
    return page_index


def _one_page(idx, item):
    if isinstance(item, str):
        return [(idx, item, None)]
    if isinstance(item, tuple) and len(item) >= 2:
        return [(_page_index_of({"pageIndex": item[0]}, idx), str(item[1] or ""), None)]
    if isinstance(item, dict):
        return [(_page_index_of(item, idx), str(item.get("text") or ""), item.get("id"))]
    return []


def _normalize_pages(page_items):
    if isinstance(page_items, str):
        return [(0, page_items, None)]
    if not isinstance(page_items, (list, tuple)):
        return []
    pages = []
    for idx, item in enumerate(page_items):
        pages.extend(_one_page(idx, item))
    return pages


def _as_list(items):
    if isinstance(items, list):
        return items
    if isinstance(items, tuple):
        return list(items)
    return []


def _units_from_pages(pages):
    units = []
    for page_index, text, item_id in pages:
        for sentence in _sentences(text):
            units.append((page_index, sentence, item_id))
    return units


def _caption_units(tables):
    units = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        page_index = _page_index_of(table, 0)
        for sentence in _sentences(str(table.get("caption") or "")):
            units.append((page_index, sentence, table.get("id")))
    return units


def _screening_signal(page_index, text, item_id):
    screened = _first_int(_SCREENED_RE, text)
    excluded = _first_int(_EXCLUDED_RE, text)
    randomized = _cohort_base(text)
    if screened is None or excluded is None or randomized is None:
        return []
    expected = screened - excluded
    if expected == randomized:
        return []
    return _consort(
        page_index, text, item_id,
        f"Screened {screened} - excluded {excluded} = {expected}, not randomized {randomized}",
        {"screened": screened, "excluded": excluded, "randomized": randomized},
        {"check": "screening", "expected": expected},
    )


def _attrition_signal(page_index, text, item_id):
    base = _cohort_base(text)
    loss = _sum_groups(_LOSS_RE, text)
    end = _first_int(_END_RE, text)
    if base is None or loss is None or end is None:
        return []
    expected = base - loss
    if expected == end:
        return []
    return _consort(
        page_index, text, item_id,
        f"Randomized {base} - attrition {loss} = {expected}, not analyzed {end}",
        {"randomized": base, "attrition": loss, "analyzed": end},
        {"check": "attrition", "expected": expected},
    )


def _allocation_signal(page_index, text, item_id, total, arms):
    return _consort(
        page_index, text, item_id,
        f"Arm counts {arms} sum to {sum(arms)}, not {total}",
        {"total": total, "arms": arms},
        {"check": "allocation", "armSum": sum(arms), "expected": total},
    )


def _paren_arm_signal(page_index, text, item_id):
    match = _ARM_PAREN_RE.search(text)
    if match is None:
        return []
    total = int(match.group(1))
    arms = [int(tok.group(1)) for tok in _ARM_TOKEN_RE.finditer(match.group(2))]
    if len(arms) < 2 or sum(arms) == total:
        return []
    return _allocation_signal(page_index, text, item_id, total, arms)


def _assigned_arm_signal(page_index, text, item_id):
    total = _first_int(_ENROLLED_N_RE, text)
    arms = [int(match.group(1)) for match in _ASSIGNED_RE.finditer(text)]
    if total is None or len(arms) < 2 or sum(arms) == total:
        return []
    return _allocation_signal(page_index, text, item_id, total, arms)


def _date_spans(text):
    return [match.span() for match in _DATE_RE.finditer(text or "")]


def _in_spans(span, spans):
    start, end = span
    for left, right in spans:
        if start < right and end > left:
            return True
    return False


def _inside_brackets(text, start, end):
    left = text.rfind("[", 0, start)
    if left < 0 or text.rfind("]", 0, start) > left:
        return False
    right = text.find("]", end)
    return right >= 0 and right - left <= 48


def _fraction_blocked(text, start, end):
    window = text[max(0, start - 60):end + 48]
    if _RATIO_RE.search(window) or _ABBREV_RATIO_RE.search(window):
        return True
    if _inside_brackets(text, start, end):
        return True
    return _CITE_RE.search(window) is not None


def _fraction_clinical(text, start, end):
    window = text[max(0, start - 48):end + 48]
    if _CLINICAL_RE.search(window):
        return True
    return _PCT_AFTER_RE.search(text[end:end + 18]) is not None


def _keep_fraction(text, match, spans):
    if _in_spans(match.span(), spans):
        return False
    numerator, denominator = int(match.group(1)), int(match.group(2))
    if denominator <= 0 or numerator <= denominator:
        return False
    if _fraction_blocked(text, match.start(), match.end()):
        return False
    return _fraction_clinical(text, match.start(), match.end())


def _fraction_signals(page_index, text, item_id):
    signals = []
    spans = _date_spans(text)
    for match in _FRAC_RE.finditer(text or ""):
        if not _keep_fraction(text, match, spans):
            continue
        numerator, denominator = int(match.group(1)), int(match.group(2))
        signals.append(_flow_signal(
            "event_exceeds_denominator", "denominator-overflow",
            page_index, text, f"{numerator}/{denominator} exceeds the denominator",
            {"numerator": numerator, "denominator": denominator},
            {"check": "fraction", "overflow": numerator - denominator},
            item_id,
        ))
    return signals


def _scan_unit(page_index, text, item_id):
    signals = []
    signals.extend(_screening_signal(page_index, text, item_id))
    signals.extend(_attrition_signal(page_index, text, item_id))
    signals.extend(_paren_arm_signal(page_index, text, item_id))
    signals.extend(_assigned_arm_signal(page_index, text, item_id))
    signals.extend(_fraction_signals(page_index, text, item_id))
    return signals


def _scan_units(units):
    signals = []
    for page_index, sentence, item_id in units:
        signals.extend(_scan_unit(page_index, sentence, item_id))
    return signals


def _clean_label(text):
    return re.sub(r"\s+", " ", str(text or "")).strip(" :;.*").lower()


def _leading_int(text):
    match = _LEADING_INT_RE.match(text or "")
    if match is None:
        return None
    return int(match.group(1))


def _caption_text(item):
    parts = [str(item.get("caption") or "")]
    footnotes = item.get("footnotes")
    if isinstance(footnotes, list):
        parts.extend(str(note) for note in footnotes)
    elif isinstance(footnotes, str):
        parts.append(footnotes)
    return " ".join(part for part in parts if part.strip())


def _at(row, index):
    if isinstance(row, dict):
        return str(row.get(index, ""))
    if index < len(row):
        return str(row[index])
    return ""


def _grid_from_rows(item):
    rows = item.get("rows")
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], (list, tuple)):
        return None
    headers = [str(cell) for cell in (item.get("headers") or [])]
    body = [[str(cell) for cell in row] for row in rows if isinstance(row, (list, tuple))]
    return headers, body


def _cell_list(item):
    if isinstance(item.get("cells"), list):
        return item["cells"]
    table = item.get("table")
    if isinstance(table, dict) and isinstance(table.get("cells"), list):
        return table["cells"]
    return None


def _place_cell(matrix, header_rows, cell):
    if not isinstance(cell, dict):
        return False
    row, col = cell.get("row"), cell.get("column")
    if type(row) is not int or isinstance(row, bool) or type(col) is not int or isinstance(col, bool):
        return False
    matrix.setdefault(row, {})[col] = str(cell.get("text") or "")
    if cell.get("header") is True:
        header_rows.add(row)
    return True


def _cell_matrix(cells):
    matrix, header_rows = {}, set()
    for cell in cells:
        if not _place_cell(matrix, header_rows, cell):
            continue
    return matrix, header_rows


def _matrix_grid(matrix, header_rows):
    ordered = sorted(matrix)
    header_idx = min(header_rows) if header_rows else ordered[0]
    width = max(max(cols) for cols in matrix.values()) + 1
    headers = [_at(matrix[header_idx], col) for col in range(width)]
    rows = []
    for row in ordered:
        if row == header_idx:
            continue
        rows.append([_at(matrix[row], col) for col in range(width)])
    return headers, rows


def _grid_from_cells(item):
    cells = _cell_list(item)
    if not cells:
        return None
    matrix, header_rows = _cell_matrix(cells)
    if not matrix:
        return None
    return _matrix_grid(matrix, header_rows)


def _pack_table(page_index, item_id, caption, headers, rows):
    lines = [caption, " ".join(headers)]
    for row in rows:
        lines.append(" ".join(row))
    return {
        "pageIndex": page_index,
        "itemId": item_id,
        "caption": caption,
        "headers": headers,
        "rows": rows,
        "blob": "\n".join(lines),
    }


def _normalize_table(item):
    if not isinstance(item, dict):
        return None
    grid = _grid_from_rows(item)
    if grid is None:
        grid = _grid_from_cells(item)
    if grid is None:
        return None
    headers, rows = grid
    return _pack_table(_page_index_of(item, 0), item.get("id"), _caption_text(item), headers, rows)


def _has_delayed(text):
    low = text.lower()
    if "delayed-entry" in low or "delayed entry" in low:
        return True
    return "left-truncated" in low or "left truncated" in low


def _skip_risk_table(table_text, page_text):
    if "number at risk" not in table_text.lower():
        return False
    return _has_delayed(table_text) or _has_delayed(page_text)


def _n_columns(norm):
    found = []
    for idx, header in enumerate(norm["headers"]):
        match = _N_RE.search(header)
        if match is not None:
            found.append((idx, int(match.group(1))))
    return found


def _column_series(norm, col):
    series = []
    for row in norm["rows"]:
        series.append((_at(row, 0), _leading_int(_at(row, col)), row))
    return series


def _counts_by_label(series):
    found = {}
    for label, count, _row in series:
        if count is None:
            continue
        key = _clean_label(label)
        if key and key not in found:
            found[key] = count
    return found


def _missing_label(rows):
    for row in rows:
        if row and _MISSING_LABEL_RE.match(_clean_label(row[0])):
            return True
    return False


def _missing_noted(norm):
    if _missing_label(norm["rows"]):
        return True
    return _MISSING_NOTE_RE.search(norm["blob"]) is not None


def _subgroup_signal(norm, excerpt, detail, reported, computed):
    return _flow_signal(
        "subgroup_sum_mismatch", "denominator-sum-mismatch",
        norm["pageIndex"], excerpt, detail, reported, computed, norm["itemId"],
    )


def _emit_pair(norm, n_col, left, right, name, missing):
    total = left + right
    if total == n_col or (total < n_col and missing):
        return []
    return [_subgroup_signal(
        norm, name, f"{name} sums to {total}, not column N {n_col}",
        {"pair": name, "left": left, "right": right, "columnN": n_col},
        {"check": "partition", "sum": total, "expected": n_col},
    )]


def _yes_no_pole(label):
    match = _YN_RE.fullmatch(_clean_label(label))
    if match is None:
        return None
    return (match.group(1) or "").strip(), match.group(2).lower()


def _yes_no_groups(series):
    groups = {}
    for label, count, _row in series:
        pole = _yes_no_pole(label)
        if pole is None or count is None:
            continue
        prefix, side = pole
        slot = groups.setdefault(prefix, {})
        if side not in slot:
            slot[side] = count
    return groups


def _yes_no_pairs(norm, n_col, series, missing):
    signals = []
    for poles in _yes_no_groups(series).values():
        if "yes" in poles and "no" in poles:
            signals.extend(_emit_pair(norm, n_col, poles["yes"], poles["no"], "yes+no", missing))
    return signals


def _named_pairs(norm, n_col, found, missing):
    signals = []
    for left, right, name in _SEX_PAIRS:
        if left in found and right in found:
            signals.extend(_emit_pair(norm, n_col, found[left], found[right], name, missing))
    return signals


def _partition_signals(norm, n_col, series, missing):
    signals = _named_pairs(norm, n_col, _counts_by_label(series), missing)
    if _MULTI_RE.search(norm["blob"]):
        return signals
    signals.extend(_yes_no_pairs(norm, n_col, series, missing))
    return signals


def _row_cap_signals(norm, n_col, series):
    signals = []
    for label, count, row in series:
        if count is None or count <= n_col:
            continue
        signals.append(_subgroup_signal(
            norm, " | ".join(row),
            f"{label} count {count} exceeds column N {n_col}",
            {"label": _clean_label(label), "count": count, "columnN": n_col},
            {"check": "row-cap", "overflow": count - n_col},
        ))
    return signals


def _subgroup_signals(norm):
    missing = _missing_noted(norm)
    signals = []
    for col, n_col in _n_columns(norm):
        series = _column_series(norm, col)
        signals.extend(_partition_signals(norm, n_col, series, missing))
        signals.extend(_row_cap_signals(norm, n_col, series))
    return signals


def _table_fraction_signals(norm):
    signals = []
    for row in norm["rows"]:
        signals.extend(_fraction_signals(norm["pageIndex"], " | ".join(row), norm["itemId"]))
    return signals


def _one_table(table, page_text):
    norm = _normalize_table(table)
    if norm is None:
        return []
    if _skip_risk_table(norm["blob"], page_text):
        return []
    return _subgroup_signals(norm) + _table_fraction_signals(norm)


def _audit_tables(tables, pages):
    page_text = "\n".join(text for _page, text, _item in pages)
    signals = []
    for table in tables:
        signals.extend(_one_table(table, page_text))
    return signals


def _p_is_null(op, raw):
    try:
        value = float(raw)
    except ValueError:
        return False
    return op in ("=", ">", ">=", "≥") and value >= 0.05


def _is_null_result(sentence):
    if _NONSIG_RE.search(sentence):
        return True
    for match in _P_RE.finditer(sentence):
        if _p_is_null(match.group(1), match.group(2)):
            return True
    return False


def _is_design(sentence):
    if _DESIGN_RE.search(sentence):
        return True
    return _is_null_result(sentence)


def _is_causal(sentence):
    if _EXEMPT_RE.search(sentence):
        return False
    return _CAUSAL_RE.search(sentence) is not None


def _d3_hints(units):
    design = [sentence for _page, sentence, _item in units if _is_design(sentence)]
    if not design:
        return []
    anchor = design[0]
    hints = []
    for page_index, sentence, _item in units:
        if not _is_causal(sentence):
            continue
        hints.append(_hint(
            "D3", "d3_causal_overclaim_hint", "causal-overclaim", page_index, sentence,
            "Design or null result is paired with a causal conclusion",
            {"designExcerpt": _clip(anchor)},
            {"advisoryOnly": True},
        ))
    return hints


def _metric_phrase(raw):
    phrase = " ".join(str(raw or "").lower().split())
    return re.sub(r"^(?:the|a|an)\s+", "", phrase).strip(" :,-")


def _sentence_comps(sentence):
    found = []
    for pattern in (_NUM_ARM_RE, _NUM_VS_RE):
        for match in pattern.finditer(sentence):
            metric = _metric_phrase(match.group("metric"))
            if metric:
                found.append((metric, float(match.group("tv")), float(match.group("cv")), sentence))
    return found


def _collect_comps(units):
    found = []
    for _page, sentence, _item in units:
        found.extend(_sentence_comps(sentence))
    return found


def _metric_words(metric):
    return [word for word in re.findall(r"[a-z]{5,}", metric) if word != "rate"]


def _metric_ok(metric, sentence):
    low = sentence.lower()
    if metric and metric in low:
        return True
    return any(word in low for word in _metric_words(metric))


def _claim_direction(sentence):
    match = _CLAIM_RE.search(sentence)
    if match is None:
        return None
    word = match.group("direction").lower()
    if word in ("reduced", "lowered", "decreased"):
        return "decreased"
    if word in ("increased", "raised"):
        return "increased"
    return None


def _values_inverted(direction, treatment, control):
    if direction == "decreased":
        return treatment > control
    return direction == "increased" and treatment < control


def _inverted_comp(comps, sentence, direction):
    for metric, treatment, control, source in comps:
        if _metric_ok(metric, sentence) and _values_inverted(direction, treatment, control):
            return metric, treatment, control, source
    return None


def _s1_hints(units):
    comps = _collect_comps(units)
    if not comps:
        return []
    hints = []
    for page_index, sentence, _item in units:
        direction = _claim_direction(sentence)
        inverted = None if direction is None else _inverted_comp(comps, sentence, direction)
        if inverted is None:
            continue
        metric, treatment, control, source = inverted
        hints.append(_hint(
            "S1", "s1_polarity_inversion_hint", "polarity-inversion", page_index, sentence,
            f"Claim says treatment {direction} while values are {treatment} vs {control}",
            {"metric": metric, "treatment": treatment, "control": control, "direction": direction},
            {"advisoryOnly": True, "numericExcerpt": _clip(source)},
        ))
    return hints


def _dedupe_signals(signals):
    seen, unique = set(), []
    for sig in signals:
        key = (sig["kind"], sig["pageIndex"], sig.get("itemId"), sig["excerpt"], _stable(sig["reported"]))
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    return unique


def _dedupe_hints(hints):
    seen, unique = set(), []
    for hint in hints:
        key = (hint["kind"], hint["pageIndex"], hint["excerpt"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(hint)
    return unique


def _cap(items, limit, prefix):
    capped = []
    for index, item in enumerate(items[:limit]):
        capped.append({"id": f"{prefix}-{index + 1}", **item})
    return capped, len(items) > limit


def _empty_report():
    return {
        "schema": SCHEMA,
        "signalCount": 0,
        "truncatedSignals": False,
        "signals": [],
        "hintCount": 0,
        "truncatedHints": False,
        "triageHints": [],
    }


def audit_flow_and_spin_triage(page_items, *, table_items=None, max_signals=30, max_hints=20):
    """Audit participant-flow arithmetic and return separated spin-triage hints."""
    _require_limit(max_signals)
    _require_limit(max_hints)
    _reject_red_keys(page_items)
    _reject_red_keys(table_items)
    pages = _normalize_pages(page_items)
    tables = _as_list(table_items)
    units = _units_from_pages(pages)
    units.extend(_caption_units(tables))
    signals = _scan_units(units)
    signals.extend(_audit_tables(tables, pages))
    hints = _d3_hints(units)
    hints.extend(_s1_hints(units))
    capped_signals, truncated_signals = _cap(_dedupe_signals(signals), max_signals, "flow")
    capped_hints, truncated_hints = _cap(_dedupe_hints(hints), max_hints, "hint")
    report = _empty_report()
    report["signalCount"] = len(capped_signals)
    report["truncatedSignals"] = truncated_signals
    report["signals"] = capped_signals
    report["hintCount"] = len(capped_hints)
    report["truncatedHints"] = truncated_hints
    report["triageHints"] = capped_hints
    return report
