"""Offline IMRaD internal-consistency audit. No network and no RED labels."""
import json
import re

SCHEMA = "falsify.internal-consistency.v1"
_FORBIDDEN = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_SECTION_ALIASES = (
    ("abstract", ("abstract", "summary", "초록", "요약")),
    ("introduction", ("introduction", "background", "서론")),
    ("methods", (
        "methods", "materials and methods", "study design", "patients and methods", "방법", "연구방법",
    )),
    ("results", ("results", "findings", "결과")),
    ("discussion", ("discussion", "고찰")),
    ("conclusion", ("conclusion", "conclusions", "결론")),
)
_SAME_ROLES = frozenset({"total", "randomized", "enrolled", "analyzed"})
_CROSS_ROLES = (
    frozenset({"total", "randomized"}),
    frozenset({"total", "enrolled"}),
)
_ROLE_PATTERNS = (
    ("arm", re.compile(r"\b(?:treatment|control|intervention|placebo)\b|\barm\b", re.I)),
    ("per_protocol", re.compile(r"per-?\s*protocol|\bcompleters?\b", re.I)),
    ("itt", re.compile(r"\bITT\b|intention-to-treat|intention to treat", re.I)),
    ("discovery", re.compile(r"\bdiscovery\b", re.I)),
    ("validation", re.compile(r"\bvalidation\b", re.I)),
    ("screened", re.compile(r"\bscreened\b|assessed for eligibility", re.I)),
    ("eligible", re.compile(r"\beligible\b", re.I)),
    ("subgroup", re.compile(r"\bsubgroup\b", re.I)),
    ("randomized", re.compile(r"\brandomi[sz]ed\b", re.I)),
    ("enrolled", re.compile(r"\benrolled\b", re.I)),
    ("analyzed", re.compile(r"\banaly[sz]ed\b", re.I)),
)
_MENTION_RES = (
    re.compile(r"\b[Nn]\s*=\s*(?P<num>\d+)\b"),
    re.compile(
        r"\b(?:enrolled|randomized|randomised|screened|analyzed|analysed)\s+(?P<num>\d+)\b",
        re.I,
    ),
    re.compile(r"\b(?P<num>\d+)\s+(?:patients|participants|subjects|individuals|people)\b", re.I),
    re.compile(r"총\s*(?P<num>\d+)\s*명"),
)
_METRIC_RES = (
    re.compile(
        r"\b(?P<metric>mortality|response rate|accuracy|primary endpoint)\b"
        r"[^.]{0,40}?\b(?:was|were|of)\s+(?P<value>\d+(?:\.\d+)?)\s*%",
        re.I,
    ),
    re.compile(
        r"\b(?P<metric>AUC|AUROC|accuracy|mortality|response rate)\s*=\s*(?P<value>\d+(?:\.\d+)?)\s*%?",
        re.I,
    ),
    re.compile(
        r"\b(?P<adj>unadjusted|adjusted|crude)?\s*(?P<metric>aOR|OR|aHR|HR|aRR|RR)\s*=\s*(?P<value>\d+(?:\.\d+)?)",
        re.I,
    ),
)
_P_EQ_RE = re.compile(r"\bp\s*=\s*(?P<p>\d*\.\d+|\d+(?:\.\d+)?)", re.I)
_DURATION_RE = re.compile(r"primary endpoint(?:\s+\w+){0,6}\s+at\s+(\d+)\s+months?", re.I)
_ALPHA_RE = re.compile(r"\balpha\s*=\s*(\d+(?:\.\d+)?)", re.I)
_FOLD_RE = re.compile(r"\b(\d+)\s*-?\s*fold cross-validation\b", re.I)
_AGE_RE = re.compile(r"\baged\s+(\d+)\s+to\s+(\d+)\s+years\b", re.I)
_ALT_ANALYSIS_RE = re.compile(r"\b(sensitivity analysis|secondary analysis|post hoc|post-hoc)\b", re.I)
_PRIMARY_NAME_RE = re.compile(
    r"\bthe primary (?:endpoint|outcome) was\s+(?!assessed\b)(?P<name>[^.]{3,80})",
    re.I,
)
_NON_SIG_RE = re.compile(r"\b(?:not significant|non-significant|nonsignificant)\b", re.I)
_SECONDARY_CLAIM_RE = re.compile(
    r"\bsecondary\b.{0,80}\b(?:improved|significant|efficacy|superior)\b"
    r"|\b(?:improved|significant|efficacy|superior)\b.{0,80}\bsecondary\b",
    re.I | re.S,
)
_ADJUSTED_FOR_RE = re.compile(r"\badjusted for\s+(?P<covs>[^.]{3,160})", re.I)
_ADJUST_WORD_RE = re.compile(r"\b(adjusted|adjustment|multivariable|covariate|aOR|aHR|aRR)\b", re.I)
_CRUDE_STAT_RE = re.compile(r"\bp\s*=|\bcompared\b|\bversus\b|\bunadjusted\b|\bcrude\b", re.I)
_METRIC_ALIASES = {"aor": "or", "ahr": "hr", "arr": "rr"}
_ADJUSTED_TOKENS = frozenset({"aor", "ahr", "arr"})
_ENDPOINT_PROMPT = (
    "Verify whether the abstract or conclusion emphasizes an endpoint other than "
    "the prespecified primary endpoint after a non-significant primary result."
)
_COVARIATE_PROMPT = (
    "Verify whether Results report the prespecified multivariable adjustment or only crude comparisons."
)


def _alias_len(item):
    return len(item[0])


def _alias_table():
    pairs = []
    for section, aliases in _SECTION_ALIASES:
        for alias in aliases:
            pairs.append((alias, section))
    pairs.sort(key=_alias_len, reverse=True)
    return tuple(pairs)


_HEADING_ALIASES = _alias_table()


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


def _excerpt(text):
    if len(text) <= 220:
        return text
    return text[:220]


def _stable(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)


def _page_index_of(item, fallback):
    page_index = item.get("pageIndex", fallback) if isinstance(item, dict) else fallback
    if type(page_index) is not int or isinstance(page_index, bool):
        return fallback
    return page_index


def _page(page_index, text, item_id):
    return {"pageIndex": page_index, "text": str(text or ""), "id": item_id}


def _one_page(idx, item):
    if isinstance(item, str):
        return [_page(idx, item, None)]
    if isinstance(item, tuple) and len(item) >= 2:
        return [_page(_page_index_of({"pageIndex": item[0]}, idx), item[1], None)]
    if isinstance(item, dict):
        return [_page(_page_index_of(item, idx), item.get("text"), item.get("id"))]
    return []


def _normalize_pages(page_items):
    if isinstance(page_items, str):
        return [_page(0, page_items, None)]
    if not isinstance(page_items, (list, tuple)):
        return []
    pages = []
    for idx, item in enumerate(page_items):
        pages.extend(_one_page(idx, item))
    return pages


def _clean_heading(raw):
    lowered = raw.strip().lower()
    lowered = re.sub(r"^[\divxlcdm]+[.)]\s*", "", lowered)
    return lowered.strip(" #*")


def _after_colon(raw):
    colon = raw.find(":")
    if colon < 0:
        return ""
    return raw[colon + 1:].strip()


def _split_heading(line):
    raw = line.strip()
    lowered = _clean_heading(raw)
    for alias, section in _HEADING_ALIASES:
        if lowered == alias:
            return section, ""
        if lowered.startswith(alias + ":"):
            return section, _after_colon(raw)
    return None, ""


def _line_sentences(line):
    stripped = line.strip()
    if not stripped:
        return []
    parts = re.split(r"(?<=[.!?])\s+", stripped)
    return [part.strip() for part in parts if part.strip()]


def _note_section(state, section):
    state["section"] = section
    if section not in state["found"]:
        state["found"].append(section)


def _add_sentences(page, text, state):
    if state["section"] is None or not text or not str(text).strip():
        return
    for sentence in _line_sentences(text):
        if sentence in page["text"]:
            state["units"].append({
                "section": state["section"],
                "pageIndex": page["pageIndex"],
                "text": sentence,
            })


def _consume_line(page, line, state):
    section, rest = _split_heading(line)
    if section is not None:
        _note_section(state, section)
        _add_sentences(page, rest, state)
        return
    if state["section"] is None:
        return
    _add_sentences(page, line, state)


def _consume_page(page, state):
    lines = page["text"].splitlines() or [page["text"]]
    for line in lines:
        _consume_line(page, line, state)


def _segment_pages(pages):
    state = {"section": None, "found": [], "units": []}
    for page in pages:
        _consume_page(page, state)
    return state["found"], state["units"]


def _window(text, start, end):
    return text[max(0, start - 48):min(len(text), end + 32)]


def _without_cross_validation(window):
    return re.sub(r"cross-?\s*validation", " ", window, flags=re.I)


def _role_for(window):
    cleaned = _without_cross_validation(window)
    for name, pattern in _ROLE_PATTERNS:
        target = cleaned if name == "validation" else window
        if pattern.search(target):
            return name
    return "total"


def _mention_from(unit, match):
    return {
        "section": unit["section"],
        "pageIndex": unit["pageIndex"],
        "text": unit["text"],
        "role": _role_for(_window(unit["text"], match.start(), match.end())),
        "n": int(match.group("num")),
    }


def _mentions_in_unit(unit):
    found, seen = [], set()
    for pattern in _MENTION_RES:
        for match in pattern.finditer(unit["text"]):
            item = _mention_from(unit, match)
            key = (item["role"], item["n"])
            if key in seen:
                continue
            seen.add(key)
            found.append(item)
    return found


def _cohort_mentions(units, sections):
    mentions = []
    for unit in units:
        if unit["section"] in sections:
            mentions.extend(_mentions_in_unit(unit))
    return mentions


def _roles_conflict(left, right):
    if left == right and left in _SAME_ROLES:
        return True
    return frozenset({left, right}) in _CROSS_ROLES


def _signal(kind, family, subtype, later, anchor, detail, reported, computed):
    return {
        "family": family,
        "kind": kind,
        "subtype": subtype,
        "pageIndex": later["pageIndex"],
        "excerpt": _excerpt(later["text"]),
        "anchorPageIndex": anchor["pageIndex"],
        "anchorSection": anchor["section"],
        "anchorExcerpt": _excerpt(anchor["text"]),
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }


def _sample_pair(anchor, other):
    if anchor["n"] == other["n"]:
        return None
    if not _roles_conflict(anchor["role"], other["role"]):
        return None
    detail = (
        f"Cohort size {anchor['n']} in {anchor['section']} disagrees with "
        f"{other['n']} in {other['section']}."
    )
    reported = {"section": anchor["section"], "role": anchor["role"], "n": anchor["n"]}
    computed = {"section": other["section"], "role": other["role"], "n": other["n"]}
    return _signal(
        "abstract_results_sample_size_mismatch", "D1", "internal-n-drift",
        other, anchor, detail, reported, computed,
    )


def _sample_signals(units):
    abstract = _cohort_mentions(units, {"abstract"})
    later = _cohort_mentions(units, {"methods", "results"})
    signals = []
    for anchor in abstract:
        for other in later:
            signal = _sample_pair(anchor, other)
            if signal is not None:
                signals.append(signal)
    return signals


def _metric_key(metric):
    token = re.sub(r"\s+", " ", metric.strip().lower())
    return _METRIC_ALIASES.get(token, token)


def _adjustment_of(metric_raw, window, match):
    token = metric_raw.lower()
    if token in _ADJUSTED_TOKENS:
        return "adjusted"
    adj = match.groupdict().get("adj")
    if isinstance(adj, str) and adj.lower() == "adjusted":
        return "adjusted"
    if isinstance(adj, str) and adj.lower() in {"unadjusted", "crude"}:
        return "unadjusted"
    if re.search(r"\badjusted\b", window, re.I):
        return "adjusted"
    if re.search(r"\bunadjusted\b|\bcrude\b", window, re.I):
        return "unadjusted"
    return "unspecified"


def _split_label(sentence):
    lowered = _without_cross_validation(sentence).lower()
    if re.search(r"\bvalidation\b", lowered):
        return "validation"
    if re.search(r"\btest\b", lowered):
        return "test"
    if re.search(r"\btraining\b|\btrain\b", lowered):
        return "train"
    return None


def _time_label(sentence):
    match = re.search(r"\b(\d+)\s*-?\s*months?\b", sentence, re.I)
    if match is None:
        return None
    return match.group(1)


def _metric_record(unit, match):
    metric_raw = match.group("metric")
    window = _window(unit["text"], match.start(), match.end())
    p_match = _P_EQ_RE.search(unit["text"])
    p_value = float(p_match.group("p")) if p_match else None
    return {
        "section": unit["section"],
        "pageIndex": unit["pageIndex"],
        "text": unit["text"],
        "metric": _metric_key(metric_raw),
        "value": float(match.group("value")),
        "adjustment": _adjustment_of(metric_raw, window, match),
        "split": _split_label(unit["text"]),
        "time": _time_label(unit["text"]),
        "p": p_value,
    }


def _metrics_in_unit(unit):
    records, seen = [], set()
    for pattern in _METRIC_RES:
        for match in pattern.finditer(unit["text"]):
            record = _metric_record(unit, match)
            key = (record["metric"], record["value"], record["adjustment"])
            if key in seen:
                continue
            seen.add(key)
            records.append(record)
    return records


def _metric_records(units, section):
    records = []
    for unit in units:
        if unit["section"] == section:
            records.extend(_metrics_in_unit(unit))
    return records


def _numbers_differ(left, right):
    if left is None or right is None:
        return False
    return abs(float(left) - float(right)) > 1e-6


def _adjustments_compatible(left, right):
    if left == "adjusted" or right == "adjusted":
        return left == right
    return True


def _labels_block(left, right):
    if left is None or right is None:
        return False
    return left != right


def _context_compatible(anchor, other):
    if not _adjustments_compatible(anchor["adjustment"], other["adjustment"]):
        return False
    if _labels_block(anchor.get("split"), other.get("split")):
        return False
    if _labels_block(anchor.get("time"), other.get("time")):
        return False
    return True


def _effect_pair(anchor, other):
    if anchor["metric"] != other["metric"]:
        return None
    if not _context_compatible(anchor, other):
        return None
    value_diff = _numbers_differ(anchor["value"], other["value"])
    p_diff = _numbers_differ(anchor.get("p"), other.get("p"))
    if not value_diff and not p_diff:
        return None
    detail = (
        f"{anchor['metric']} {anchor['value']} (p={anchor.get('p')}) in {anchor['section']} "
        f"disagrees with {other['value']} (p={other.get('p')}) in {other['section']}."
    )
    reported = {
        "section": anchor["section"], "metric": anchor["metric"],
        "value": anchor["value"], "p": anchor.get("p"),
    }
    computed = {
        "section": other["section"], "metric": other["metric"],
        "value": other["value"], "p": other.get("p"),
    }
    return _signal(
        "abstract_results_effect_or_p_mismatch", "D1", "internal-metric-drift",
        other, anchor, detail, reported, computed,
    )


def _effect_signals(units):
    signals = []
    for anchor in _metric_records(units, "abstract"):
        for other in _metric_records(units, "results"):
            signal = _effect_pair(anchor, other)
            if signal is not None:
                signals.append(signal)
    return signals


def _first_match(units, section, pattern):
    for unit in units:
        if unit["section"] != section:
            continue
        match = pattern.search(unit["text"])
        if match is not None:
            return unit, match
    return None, None


def _results_blocked(unit):
    return _ALT_ANALYSIS_RE.search(unit["text"]) is not None


def _protocol_signal(detail, later, anchor, reported, computed):
    return _signal(
        "methods_results_protocol_drift", "D4-1", "methods-results-drift",
        later, anchor, detail, reported, computed,
    )


def _scalar_protocol(units, pattern, parameter, label):
    methods_unit, methods_match = _first_match(units, "methods", pattern)
    results_unit, results_match = _first_match(units, "results", pattern)
    if methods_unit is None or results_unit is None:
        return []
    if _results_blocked(results_unit):
        return []
    left = methods_match.group(1)
    right = results_match.group(1)
    if left == right:
        return []
    detail = f"{label} {left} in Methods disagrees with {right} in Results."
    reported = {"parameter": parameter, "value": _numberish(left)}
    computed = {"parameter": parameter, "value": _numberish(right)}
    return [_protocol_signal(detail, results_unit, methods_unit, reported, computed)]


def _numberish(raw):
    if re.fullmatch(r"\d+", raw):
        return int(raw)
    return float(raw)


def _duration_signals(units):
    return _scalar_protocol(units, _DURATION_RE, "primary_follow_up_months", "Primary follow-up months")


def _alpha_signals(units):
    return _scalar_protocol(units, _ALPHA_RE, "alpha", "Alpha")


def _fold_signals(units):
    return _scalar_protocol(units, _FOLD_RE, "cross_validation_folds", "Cross-validation folds")


def _age_tuple(match):
    return (int(match.group(1)), int(match.group(2)))


def _age_signals(units):
    methods_unit, methods_match = _first_match(units, "methods", _AGE_RE)
    results_unit, results_match = _first_match(units, "results", _AGE_RE)
    if methods_unit is None or results_unit is None:
        return []
    if _results_blocked(results_unit):
        return []
    left = _age_tuple(methods_match)
    right = _age_tuple(results_match)
    if left == right:
        return []
    detail = f"Age eligibility {left[0]}-{left[1]} in Methods disagrees with {right[0]}-{right[1]} in Results."
    reported = {"parameter": "age_eligibility", "value": list(left)}
    computed = {"parameter": "age_eligibility", "value": list(right)}
    return [_protocol_signal(detail, results_unit, methods_unit, reported, computed)]


def _protocol_signals(units):
    signals = []
    signals.extend(_duration_signals(units))
    signals.extend(_alpha_signals(units))
    signals.extend(_fold_signals(units))
    signals.extend(_age_signals(units))
    return signals


def _signal_key(sig):
    return (
        sig["kind"], sig["pageIndex"], sig["excerpt"], sig["anchorExcerpt"],
        _stable(sig["reported"]), _stable(sig["computed"]),
    )


def _dedupe(items, keyfn):
    seen, unique = set(), []
    for item in items:
        key = keyfn(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _collect_signals(units):
    signals = []
    signals.extend(_sample_signals(units))
    signals.extend(_effect_signals(units))
    signals.extend(_protocol_signals(units))
    return _dedupe(signals, _signal_key)


def _primary_definition(units):
    for unit in units:
        if unit["section"] != "methods":
            continue
        match = _PRIMARY_NAME_RE.search(unit["text"])
        if match is not None:
            return match.group("name").strip(), unit
    return None, None


def _p_at_least(raw, cutoff):
    try:
        return float(raw) >= cutoff
    except ValueError:
        return False


def _is_nonsignificant(sentence):
    if _NON_SIG_RE.search(sentence):
        return True
    match = _P_EQ_RE.search(sentence)
    if match is None:
        return False
    return _p_at_least(match.group("p"), 0.05)


def _nonsignificant_result(units, name):
    needle = name.lower()
    for unit in units:
        if unit["section"] != "results":
            continue
        if needle not in unit["text"].lower():
            continue
        if _is_nonsignificant(unit["text"]):
            return unit
    return None


def _section_blob(units, sections):
    parts = []
    for unit in units:
        if unit["section"] in sections:
            parts.append(unit["text"])
    return " ".join(parts)


def _emphasis_moved(units, name):
    blob = _section_blob(units, ("abstract", "conclusion"))
    if name.lower() not in blob.lower():
        return True
    if _SECONDARY_CLAIM_RE.search(blob):
        return True
    return False


def _endpoint_hint(name, methods_unit, results_unit):
    return {
        "family": "D3",
        "kind": "primary_endpoint_emphasis_shift",
        "advisoryOnly": True,
        "pageIndex": results_unit["pageIndex"],
        "excerpt": _excerpt(results_unit["text"]),
        "methodsExcerpt": _excerpt(methods_unit["text"]),
        "resultsExcerpt": _excerpt(results_unit["text"]),
        "verificationPrompt": _ENDPOINT_PROMPT,
        "detail": (
            f'Primary endpoint "{name}" is non-significant in Results while '
            "Abstract or Conclusion shifts emphasis."
        ),
        "reported": {"primaryEndpoint": name},
        "computed": {"resultsNonSignificant": True},
    }


def _endpoint_hints(units):
    name, methods_unit = _primary_definition(units)
    if methods_unit is None:
        return []
    results_unit = _nonsignificant_result(units, name)
    if results_unit is None:
        return []
    if not _emphasis_moved(units, name):
        return []
    return [_endpoint_hint(name, methods_unit, results_unit)]


def _adjusted_methods(units):
    for unit in units:
        if unit["section"] != "methods":
            continue
        if _ADJUSTED_FOR_RE.search(unit["text"]):
            return unit
    return None


def _results_mention_adjustment(units):
    for unit in units:
        if unit["section"] == "results" and _ADJUST_WORD_RE.search(unit["text"]):
            return True
    return False


def _crude_result(units):
    for unit in units:
        if unit["section"] == "results" and _CRUDE_STAT_RE.search(unit["text"]):
            return unit
    return None


def _covariate_hint(methods_unit, results_unit):
    return {
        "family": "D5",
        "kind": "declared_exclusion_or_covariate_check",
        "advisoryOnly": True,
        "pageIndex": results_unit["pageIndex"],
        "excerpt": _excerpt(results_unit["text"]),
        "methodsExcerpt": _excerpt(methods_unit["text"]),
        "resultsExcerpt": _excerpt(results_unit["text"]),
        "verificationPrompt": _COVARIATE_PROMPT,
        "detail": "Methods names adjustment covariates that Results does not mention.",
        "reported": {"methodsText": _excerpt(methods_unit["text"])},
        "computed": {"resultsMentionAdjustment": False},
    }


def _covariate_hints(units):
    methods_unit = _adjusted_methods(units)
    if methods_unit is None:
        return []
    if _results_mention_adjustment(units):
        return []
    crude = _crude_result(units)
    if crude is None:
        return []
    return [_covariate_hint(methods_unit, crude)]


def _hint_key(hint):
    return (hint["kind"], hint.get("pageIndex"), hint.get("methodsExcerpt"), hint.get("resultsExcerpt"))


def _collect_hints(units):
    hints = []
    hints.extend(_endpoint_hints(units))
    hints.extend(_covariate_hints(units))
    return _dedupe(hints, _hint_key)


def _cap(items, limit, prefix):
    capped = []
    for index, item in enumerate(items[:limit]):
        capped.append({"id": f"{prefix}-{index + 1}", **item})
    return capped, len(items) > limit


def _insufficient(found):
    return {
        "schema": SCHEMA,
        "status": "insufficient_sections",
        "sectionsDetected": list(found),
        "signalCount": 0,
        "signals": [],
        "hintCount": 0,
        "triageHints": [],
    }


def _report(found, signals, hints, max_signals, max_hints):
    capped_signals, truncated_signals = _cap(signals, max_signals, "ic")
    capped_hints, truncated_hints = _cap(hints, max_hints, "ih")
    return {
        "schema": SCHEMA,
        "status": "ok",
        "sectionsDetected": list(found),
        "signalCount": len(capped_signals),
        "truncatedSignals": truncated_signals,
        "signals": capped_signals,
        "hintCount": len(capped_hints),
        "truncatedHints": truncated_hints,
        "triageHints": capped_hints,
    }


def audit_internal_consistency(page_items, *, table_items=None, max_signals=30, max_hints=20):
    """Return cross-section contradictions separately from advisory triage hints."""
    _require_limit(max_signals)
    _require_limit(max_hints)
    _reject_red_keys(page_items)
    _reject_red_keys(table_items)
    found, units = _segment_pages(_normalize_pages(page_items))
    if len(found) < 2:
        return _insufficient(found)
    return _report(found, _collect_signals(units), _collect_hints(units), max_signals, max_hints)
