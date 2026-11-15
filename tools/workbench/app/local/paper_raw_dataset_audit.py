"""Row-level supplement recomputation for BLUE (stdlib only, read-only).

Recomputes N, per-column summaries and unadjusted two-group p-values from
CSV/TSV/JSON supplements and compares them with manuscript prose or table cells.
Adjusted and multiplicity-corrected p-values are never flagged.
"""
import csv
import io
import json
import math
import re
import statistics

import paper_stat_math as psm

SCHEMA = "falsify.raw-dataset-audit.v1"
_FORBIDDEN = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_MISSING = frozenset({"", "na", "nan", "null", ".", "missing", "n/a", "na."})
_SUMMARY_LABELS = frozenset({
    "mean", "sd", "se", "sem", "median", "iqr", "n", "total", "min", "max",
    "q1", "q3", "std", "average", "summary", "overall",
})
_GROUP_NAMES = ("group", "arm", "treatment", "cohort", "condition", "alloc")
_ID_NAMES = frozenset({"id", "subject", "patient", "participant", "record", "row", "sampleid"})
_POS = frozenset({"1", "1.0", "yes", "true", "event", "y"})
_NEG = frozenset({"0", "0.0", "no", "false", "none", "n"})
_FLAG_NAMES = ("eligible", "included", "excluded")
_SAMPLE_CUE = re.compile(
    r"\b(?:enrolled|enrolment|enrollment|cohort|participants?|patients?|subjects?|sample|randomized|randomised|included)\b",
    re.IGNORECASE,
)
_ADJUST_RE = re.compile(
    r"adjusted|multivariable|multivariate|\baor\b|\barr\b|\bahr\b|ancova|mixed model|\bcox\b|"
    r"logistic regression|\bfdr\b|bonferroni|\bholm\b|benjamini|p_adj|p-adj|\bq\s*=",
    re.IGNORECASE,
)
_N_RE = re.compile(r"\b([Nn])\s*=\s*(\d+)\b")
_PLUSMINUS_RE = re.compile(
    r"(?P<mean>\d+(?:\.\d+)?)\s*(?:±|\+/-|\u00b1)\s*(?P<sd>\d+(?:\.\d+)?)"
)
_MEAN_PAREN_RE = re.compile(
    r"mean\s*(?:=|:)?\s*(?P<mean>\d+(?:\.\d+)?)\s*\(\s*(?:SD\s*)?(?P<sd>\d+(?:\.\d+)?)\s*\)",
    re.IGNORECASE,
)
_SD_PAREN_RE = re.compile(
    r"(?P<mean>\d+(?:\.\d+)?)\s*\(\s*SD\s*(?P<sd>\d+(?:\.\d+)?)\s*\)",
    re.IGNORECASE,
)
_MEDIAN_RE = re.compile(
    r"median\s*(?:=|:)?\s*(?P<med>\d+(?:\.\d+)?)\s*\[\s*(?P<iqr>\d+(?:\.\d+)?)\s*\]",
    re.IGNORECASE,
)
_COUNT_RE = re.compile(
    r"(?P<k>\d+)\s*/\s*(?P<n>\d+)\s*\(\s*(?P<pct>\d+(?:\.\d+)?)\s*%\s*\)"
)
_P_RE = re.compile(
    r"\bp\s*(?P<op><=|>=|<|>|=)\s*(?P<p>\d*\.\d+|\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_SENT_RE = re.compile(r"(?<=[.!?])\s+|\n+")


def _assert_no_red(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _FORBIDDEN:
                raise ValueError("forbidden_red_key")
            _assert_no_red(item)
    elif isinstance(value, list):
        for item in value:
            _assert_no_red(item)


def _norm_key(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _is_missing(value):
    if value is None:
        return True
    return str(value).strip().lower() in _MISSING


def _as_number(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip().replace(",", "").replace("−", "-")
    if _is_missing(text):
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _token(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    number = _as_number(value)
    if number is None:
        return str(value).strip().lower()
    if number.is_integer():
        return str(int(number))
    return str(number)


def _validate_limit(max_signals):
    if isinstance(max_signals, bool) or type(max_signals) is not int:
        raise ValueError("limit")
    if not 1 <= max_signals <= 100:
        raise ValueError("limit")


def _excerpt(text):
    return " ".join(str(text or "").split())[:240]


def _mention_spans(text, name):
    parts = re.findall(r"[A-Za-z0-9]+", str(name or ""))
    if len("".join(parts)) < 3:
        return []
    pattern = r"\b" + r"[-_\s]*".join(re.escape(part) for part in parts) + r"s?\b"
    return list(re.finditer(pattern, text, re.IGNORECASE))


def _mentioned(name, text):
    return bool(_mention_spans(text, name))


def _nearest_name(text, start, names, window=80):
    best_at, best = -1, None
    for name in names:
        for match in _mention_spans(text, name):
            distance = start - match.end()
            if 0 <= distance <= window and match.end() >= best_at:
                best_at, best = match.end(), name
    return best


def _normalize_pages(page_items):
    pages = []
    for idx, item in enumerate(page_items or []):
        pages.extend(_page_record(item, idx))
    return pages


def _page_record(item, idx):
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        page = item[0] if isinstance(item[0], int) and not isinstance(item[0], bool) else idx
        return [{"id": f"p{idx}", "pageIndex": page, "text": str(item[1])}]
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        page = item.get("pageIndex", idx)
        if isinstance(page, bool) or not isinstance(page, int):
            page = idx
        return [{"id": item.get("id", f"p{idx}"), "pageIndex": page, "text": item["text"]}]
    return []


def _table_lines(item):
    table = item.get("table") if isinstance(item.get("table"), dict) else item
    cells = table.get("cells") if isinstance(table, dict) else None
    if isinstance(cells, list):
        return _cells_to_lines(cells)
    rows = table.get("rows") if isinstance(table, dict) else None
    if isinstance(rows, list):
        return _matrix_lines(rows)
    return []


def _cells_to_lines(cells):
    grouped = {}
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        row = cell.get("row", 0)
        grouped.setdefault(row, []).append((cell.get("column", 0), str(cell.get("text") or "")))
    lines = []
    for row in sorted(grouped):
        ordered = [text for _, text in sorted(grouped[row], key=lambda pair: pair[0])]
        lines.append(" ".join(ordered))
    return lines


def _matrix_lines(rows):
    lines = []
    for row in rows:
        if isinstance(row, (list, tuple)):
            lines.append(" ".join(str(cell) for cell in row))
        elif isinstance(row, dict):
            lines.append(" ".join(str(value) for value in row.values()))
    return lines


def _iter_claims(page_items, table_items):
    for page in _normalize_pages(page_items):
        for sentence in _sentences(page["text"]):
            yield {"pageIndex": page["pageIndex"], "text": sentence, "id": page["id"]}
    for item in table_items or []:
        if isinstance(item, dict):
            yield from _table_claims(item)


def _table_claims(item):
    caption = str(item.get("caption") or "")
    page = item.get("pageIndex", 0)
    if isinstance(page, bool) or not isinstance(page, int):
        page = 0
    for line in _table_lines(item):
        text = f"{caption} {line}".strip()
        if text:
            yield {"pageIndex": page, "text": text, "id": item.get("id")}


def _sentences(text):
    return [part.strip() for part in _SENT_RE.split(text or "") if part.strip()]


def _supplement_name(supp):
    for key in ("name", "fileName", "filename"):
        if isinstance(supp.get(key), str) and supp[key].strip():
            return supp[key].strip()
    return "supplement"


def _supplement_text(supp):
    if isinstance(supp.get("text"), str):
        return supp["text"]
    segments = supp.get("segments") or []
    chunks = []
    for segment in segments:
        if isinstance(segment, dict) and isinstance(segment.get("text"), str):
            chunks.append(segment["text"])
    return "\n".join(chunks)


def _suffix(name):
    match = re.search(r"(\.[A-Za-z0-9]+)$", name)
    return match.group(1).lower() if match else ""


def _parse_delimited(text, delimiter):
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), delimiter=delimiter)
        rows = []
        for raw in reader:
            if raw is None:
                continue
            row = {str(key): value for key, value in raw.items() if key is not None}
            if row and not all(_is_missing(value) for value in row.values()):
                rows.append(row)
        return rows
    except csv.Error:
        return []


def _json_rows(parsed):
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("rows", "data"):
            if isinstance(parsed.get(key), list):
                return parsed[key]
    return []


def _dicts_only(rows):
    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            return []
        cleaned.append({str(key): value for key, value in row.items()})
    return cleaned


def _is_summary_layout(rows):
    labels = []
    for row in rows:
        first = next(iter(row.values()), "")
        labels.append(str(first).strip().lower())
    if not labels:
        return False
    return all(label in _SUMMARY_LABELS for label in labels)


def _rows_from_text(name, text):
    suffix = _suffix(name)
    if suffix == ".json":
        return _rows_from_json(text)
    if suffix == ".csv":
        return _parse_delimited(text, ",")
    if suffix == ".tsv":
        return _parse_delimited(text, "\t")
    return []


def _rows_from_json(text):
    try:
        parsed = json.loads(text.lstrip("\ufeff"))
    except json.JSONDecodeError:
        return []
    _assert_no_red(parsed)
    return _dicts_only(_json_rows(parsed))


def _usable_rows(rows):
    if len(rows) < 3 or _is_summary_layout(rows):
        return []
    return rows


def _dataset_rows(supp):
    _assert_no_red(supp)
    rows = _usable_rows(_rows_from_text(_supplement_name(supp), _supplement_text(supp)))
    if not rows:
        return None
    return {"name": _supplement_name(supp), "rows": rows}


def _flag_value(value):
    if isinstance(value, bool):
        return value
    number = _as_number(value)
    if number in (0.0, 1.0):
        return bool(number)
    token = str(value).strip().lower()
    if token in {"1", "true", "yes", "y"}:
        return True
    if token in {"0", "false", "no", "n"}:
        return False
    return None


def _flag_column(rows):
    headers = list(rows[0].keys())
    for name in _FLAG_NAMES:
        match = next((header for header in headers if _norm_key(header) == name), None)
        if match and _flag_column_ok(rows, match):
            return {"column": match, "mode": name}
    return None


def _flag_column_ok(rows, column):
    seen = False
    for row in rows:
        if _is_missing(row.get(column)):
            continue
        if _flag_value(row.get(column)) is None:
            return False
        seen = True
    return seen


def _keep_row(row, flag):
    if flag is None:
        return True
    bit = _flag_value(row.get(flag["column"]))
    if bit is None:
        return True
    if flag["mode"] == "excluded":
        return not bit
    return bit


def _active_rows(rows, flag):
    return [row for row in rows if _keep_row(row, flag)]


def _pick_group_column(rows):
    headers = [header for header in rows[0].keys() if header]
    for name in _GROUP_NAMES:
        match = next((header for header in headers if _norm_key(header) == name), None)
        if match and _group_values(rows, match):
            return match
    for header in headers:
        if _norm_key(header) in _ID_NAMES or _norm_key(header) in _FLAG_NAMES:
            continue
        if _categorical_group(rows, header):
            return header
    return None


def _group_values(rows, header):
    values = [_token(row.get(header)) for row in rows if not _is_missing(row.get(header))]
    distinct = list(dict.fromkeys(values))
    return distinct if 2 <= len(distinct) <= 6 else []


def _categorical_group(rows, header):
    if any(_as_number(row.get(header)) is not None and not isinstance(row.get(header), bool) for row in rows if not _is_missing(row.get(header))):
        if not _all_binary_tokens(rows, header):
            return []
    return _group_values(rows, header)


def _all_binary_tokens(rows, header):
    tokens = [_token(row.get(header)) for row in rows if not _is_missing(row.get(header))]
    return bool(tokens) and all(token in _POS or token in _NEG for token in tokens)


def _split_groups(rows, column):
    if column is None:
        return [("overall", rows)]
    grouped = {}
    for row in rows:
        if _is_missing(row.get(column)):
            continue
        grouped.setdefault(_token(row.get(column)), []).append(row)
    return list(grouped.items())


def _skip_header(header, group_column, flag):
    if header == group_column:
        return True
    if flag is not None and header == flag["column"]:
        return True
    return _norm_key(header) in _ID_NAMES


def _column_names(rows, group_column, flag):
    return [header for header in rows[0].keys() if header and not _skip_header(header, group_column, flag)]


def _present_values(rows, header):
    return [row.get(header) for row in rows if not _is_missing(row.get(header))]


def _binary_token(value):
    return _token(value) in _POS or _token(value) in _NEG


def _all_binary(present):
    return bool(present) and all(_binary_token(value) for value in present)


def _all_numeric(present):
    for value in present:
        if isinstance(value, bool) or _as_number(value) is None:
            return False
    return bool(present)


def _numeric_kind(present):
    numbers = [_as_number(value) for value in present]
    if all(number in (0.0, 1.0) for number in numbers):
        return "binary"
    return "continuous"


def _text_kind(present):
    tokens = list(dict.fromkeys(_token(value) for value in present))
    if len(tokens) == 2:
        return "binary"
    if 3 <= len(tokens) <= 6:
        return "categorical"
    return "other"


def _kind_of(rows, header):
    present = _present_values(rows, header)
    if not present:
        return "empty"
    if _all_binary(present):
        return "binary"
    if _all_numeric(present):
        return _numeric_kind(present)
    return _text_kind(present)


def _mean(values):
    return sum(values) / len(values)


def _sd(values):
    if len(values) < 2:
        return None
    mu = _mean(values)
    return math.sqrt(sum((value - mu) ** 2 for value in values) / (len(values) - 1))


def _median(values):
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _iqr(values):
    if len(values) < 2:
        return None
    quarters = statistics.quantiles(values, n=4, method="inclusive")
    return quarters[2] - quarters[0]


def _continuous_summary(values, missing):
    summary = {"kind": "continuous", "n": len(values), "missing": missing}
    if not values:
        return summary
    summary["mean"] = _mean(values)
    summary["sd"] = _sd(values)
    summary["median"] = _median(values)
    summary["iqr"] = _iqr(values)
    return summary


def _positive_label(tokens):
    for label in ("1", "yes", "true", "event", "y"):
        if label in tokens:
            return label
    ordered = sorted(set(tokens))
    return ordered[-1] if ordered else None


def _level_rows(tokens):
    counts = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1
    total = len(tokens)
    levels = []
    for label, count in counts.items():
        levels.append({"label": label, "k": count, "n": total, "pct": 100.0 * count / total})
    return levels


def _binary_summary(tokens, missing):
    total = len(tokens)
    positive = _positive_label(tokens)
    k_count = sum(1 for token in tokens if token == positive)
    summary = {
        "kind": "binary" if len(set(tokens)) <= 2 else "categorical",
        "n": total,
        "missing": missing,
        "positive": positive,
        "k": k_count,
        "pct": (100.0 * k_count / total) if total else None,
        "levels": _level_rows(tokens),
    }
    return summary


def _summarize_header(rows, header):
    missing = sum(1 for row in rows if _is_missing(row.get(header)))
    kind = _kind_of(rows, header)
    if kind == "continuous":
        values = [_as_number(row.get(header)) for row in rows if _as_number(row.get(header)) is not None and not isinstance(row.get(header), bool)]
        summary = _continuous_summary(values, missing)
    elif kind in ("binary", "categorical"):
        tokens = [_token(row.get(header)) for row in rows if not _is_missing(row.get(header))]
        summary = _binary_summary(tokens, missing)
        summary["kind"] = kind
    else:
        summary = {"kind": kind, "n": len(rows) - missing, "missing": missing}
    summary["name"] = header
    return summary


def _summarize_rows(rows, headers):
    return [_summarize_header(rows, header) for header in headers]


def _welch(left, right):
    n1, n2 = len(left), len(right)
    mean1, mean2 = _mean(left), _mean(right)
    sd1, sd2 = _sd(left) or 0.0, _sd(right) or 0.0
    se2 = sd1 * sd1 / n1 + sd2 * sd2 / n2
    if se2 <= 0.0:
        same = abs(mean1 - mean2) <= 1e-12
        return {"t": 0.0 if same else None, "df": None, "p": 1.0 if same else 0.0}
    t_val = (mean1 - mean2) / math.sqrt(se2)
    v1, v2 = sd1 * sd1 / n1, sd2 * sd2 / n2
    df_val = (se2 * se2) / ((v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1))
    return {"t": t_val, "df": df_val, "p": psm.stat_pvalue("t", t_val, df_val)}


def _pooled(left, right):
    n1, n2 = len(left), len(right)
    mean1, mean2 = _mean(left), _mean(right)
    sd1, sd2 = _sd(left) or 0.0, _sd(right) or 0.0
    df_val = n1 + n2 - 2
    pooled_var = ((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / df_val
    se2 = pooled_var * (1.0 / n1 + 1.0 / n2)
    if se2 <= 0.0:
        same = abs(mean1 - mean2) <= 1e-12
        return {"t": 0.0 if same else None, "df": float(df_val), "p": 1.0 if same else 0.0}
    t_val = (mean1 - mean2) / math.sqrt(se2)
    return {"t": t_val, "df": float(df_val), "p": psm.stat_pvalue("t", t_val, df_val)}


def _numbers(rows, header):
    return [_as_number(row.get(header)) for row in rows if _as_number(row.get(header)) is not None and not isinstance(row.get(header), bool)]


def _two_sample(rows_a, rows_b, header):
    left, right = _numbers(rows_a, header), _numbers(rows_b, header)
    if len(left) < 2 or len(right) < 2:
        return None
    welch, pooled = _welch(left, right), _pooled(left, right)
    return {"variable": header, "method": "t", "welchP": welch["p"], "pooledP": pooled["p"], "welchT": welch["t"], "pooledT": pooled["t"], "welchDf": welch["df"]}


def _event_count(rows, header, positive):
    tokens = [_token(row.get(header)) for row in rows if not _is_missing(row.get(header))]
    return sum(1 for token in tokens if token == positive), len(tokens)


def _contingency(rows_a, rows_b, header, positive):
    k1, n1 = _event_count(rows_a, header, positive)
    k2, n2 = _event_count(rows_b, header, positive)
    if n1 < 2 or n2 < 2:
        return None
    a_cell, b_cell, c_cell, d_cell = k1, n1 - k1, k2, n2 - k2
    fisher = psm._fisher_exact_2x2(a_cell, n1, c_cell, n2)
    chi = psm._chi2_2x2(a_cell, b_cell, c_cell, d_cell)
    fisher_p = None if fisher[0] is None else fisher[0]
    return {
        "variable": header,
        "method": "contingency",
        "fisherP": fisher_p,
        "chi2P": chi[1],
        "table": [a_cell, b_cell, c_cell, d_cell],
    }


def _tests_for(active, headers, groups):
    if len(groups) != 2:
        return []
    (_, left), (_, right) = groups
    tests = []
    for header in headers:
        kind = _kind_of(active, header)
        if kind == "continuous":
            test = _two_sample(left, right, header)
        elif kind == "binary":
            positive = _positive_label([_token(row.get(header)) for row in active if not _is_missing(row.get(header))])
            test = _contingency(left, right, header, positive)
        else:
            test = None
        if test is not None:
            tests.append(test)
    return tests


def _group_payload(label, rows, headers, total_n):
    return {
        "label": label,
        "n": len(rows),
        "totalN": total_n,
        "columns": _summarize_rows(rows, headers),
    }


def _build_dataset(name, rows, sole):
    flag = _flag_column(rows)
    active = _active_rows(rows, flag)
    group_column = _pick_group_column(active or rows)
    headers = _column_names(rows, group_column, flag)
    grouped = _split_groups(active, group_column) if group_column else []
    totals = dict(_split_groups(rows, group_column)) if group_column else {}
    groups = []
    for label, members in grouped:
        groups.append(_group_payload(label, members, headers, len(totals.get(label, members))))
    return {
        "name": name,
        "rowCount": len(rows),
        "analysisCount": len(active),
        "flag": flag,
        "groupColumn": group_column,
        "sole": sole,
        "groups": groups,
        "overall": {"n": len(active), "columns": _summarize_rows(active, headers)},
        "tests": _tests_for(active, headers, grouped),
    }


def _stem(name):
    return _norm_key(re.sub(r"\.[A-Za-z0-9]+$", "", name))


def _linked_total(dataset, text):
    if _mentioned(_stem(dataset["name"]), text):
        return True
    return bool(dataset["sole"] and _SAMPLE_CUE.search(text))


def _arm_ns(dataset):
    found = {}
    for group in dataset["groups"]:
        found[group["label"]] = (group["n"], group["totalN"])
    return found


def _n_signals_for_claim(dataset, claim):
    text = claim["text"]
    signals = []
    signals.extend(_arm_n_signals(dataset, claim, text))
    signals.extend(_total_n_signals(dataset, claim, text))
    return signals


def _reported_numbers(text, letter):
    return [int(value) for found, value in _N_RE.findall(text) if found == letter]


def _none_match(reported, options):
    return bool(reported) and all(value not in options for value in reported)


def _arm_n_signals(dataset, claim, text):
    labels = [group["label"] for group in dataset["groups"] if _mentioned(group["label"], text)]
    if len(labels) != 1:
        return []
    reported = [value for value in _reported_numbers(text, "n") if value >= 3]
    counts = _arm_ns(dataset)[labels[0]]
    if not _none_match(reported, counts):
        return []
    return [_n_signal(claim, dataset, labels[0], reported[0], counts)]


def _total_n_signals(dataset, claim, text):
    if not _linked_total(dataset, text):
        return []
    reported = [value for value in _reported_numbers(text, "N") if value >= 3]
    options = (dataset["rowCount"], dataset["analysisCount"])
    if not _none_match(reported, options):
        return []
    return [_n_signal(claim, dataset, None, reported[0], options)]


def _n_signal(claim, dataset, group, reported, computed):
    return _signal(
        "raw_dataset_n_mismatch", "D6", "raw-n-mismatch", claim, dataset, group or "total",
        {"n": reported}, {"n": list(computed) if not isinstance(computed, list) else computed}, group,
        "Reported sample size matches neither the raw row count nor the inclusion-filtered count.",
    )


def _signal(kind, family, subtype, claim, dataset, variable, reported, computed, group, detail):
    return {
        "kind": kind,
        "family": family,
        "subtype": subtype,
        "pageIndex": claim.get("pageIndex", 0),
        "segmentId": claim.get("id"),
        "excerpt": _excerpt(claim.get("text")),
        "detail": detail,
        "variable": variable,
        "group": group,
        "supplementFile": dataset["name"],
        "reported": reported,
        "computed": computed,
    }


def _close(computed, token):
    if computed is None:
        return False
    decimals = psm.count_decimals(token)
    tolerance = 0.5 * (10 ** (-decimals)) + 1e-6
    try:
        reported = float(str(token).replace("−", "-"))
    except ValueError:
        return False
    return abs(float(computed) - reported) <= tolerance


def _column_map(block):
    return {column["name"]: column for column in block.get("columns", [])}


def _scope_column(dataset, text, start, variable):
    label = _nearest_name(text, start, [group["label"] for group in dataset["groups"]])
    if label is not None:
        group = next(item for item in dataset["groups"] if item["label"] == label)
        return _column_map(group).get(variable), label
    return _column_map(dataset["overall"]).get(variable), None


def _pattern_hits(text):
    hits = []
    for kind, pattern, fields in (
        ("mean_sd", _PLUSMINUS_RE, ("mean", "sd")),
        ("mean_sd", _MEAN_PAREN_RE, ("mean", "sd")),
        ("mean_sd", _SD_PAREN_RE, ("mean", "sd")),
        ("median_iqr", _MEDIAN_RE, ("med", "iqr")),
        ("count_pct", _COUNT_RE, ("k", "n", "pct")),
        ("p", _P_RE, ("op", "p")),
    ):
        for match in pattern.finditer(text):
            hits.append({"kind": kind, "start": match.start(), "groups": {field: match.group(field) for field in fields}})
    return hits


def _variables_in(dataset, text):
    names = [column["name"] for column in dataset["overall"]["columns"]]
    return [name for name in names if _mention_spans(text, name)]


def _bind_variable(dataset, text, start):
    names = _variables_in(dataset, text)
    if len(names) == 1:
        return names[0]
    return _nearest_name(text, start, names)


def _summary_mismatch(dataset, claim, hit, column, group):
    kind = hit["kind"]
    if kind == "mean_sd":
        return _mean_mismatch(dataset, claim, hit, column, group)
    if kind == "median_iqr":
        return _median_mismatch(dataset, claim, hit, column, group)
    if kind == "count_pct":
        return _count_mismatch(dataset, claim, hit, column, group)
    return None


def _mean_mismatch(dataset, claim, hit, column, group):
    if column is None or column.get("kind") != "continuous":
        return None
    mean_ok = _close(column.get("mean"), hit["groups"]["mean"])
    sd_ok = _close(column.get("sd"), hit["groups"]["sd"])
    if mean_ok and sd_ok:
        return None
    return _signal(
        "raw_dataset_summary_mismatch", "D1", "raw-summary-mismatch", claim, dataset, column["name"],
        {"mean": hit["groups"]["mean"], "sd": hit["groups"]["sd"]},
        {"mean": column.get("mean"), "sd": column.get("sd"), "n": column.get("n")},
        group, "Recomputed mean or sample SD differs beyond rounding.",
    )


def _median_mismatch(dataset, claim, hit, column, group):
    if column is None or column.get("kind") != "continuous":
        return None
    med_ok = _close(column.get("median"), hit["groups"]["med"])
    iqr_ok = _close(column.get("iqr"), hit["groups"]["iqr"])
    if med_ok and iqr_ok:
        return None
    return _signal(
        "raw_dataset_summary_mismatch", "D1", "raw-summary-mismatch", claim, dataset, column["name"],
        {"median": hit["groups"]["med"], "iqr": hit["groups"]["iqr"]},
        {"median": column.get("median"), "iqr": column.get("iqr"), "n": column.get("n")},
        group, "Recomputed median or IQR differs beyond rounding.",
    )


def _count_level_ok(column, hit):
    for level in column.get("levels") or []:
        k_ok = _close(level["k"], hit["groups"]["k"])
        n_ok = _close(level["n"], hit["groups"]["n"])
        pct_ok = _close(level["pct"], hit["groups"]["pct"])
        if k_ok and n_ok and pct_ok:
            return True
    return False


def _count_mismatch(dataset, claim, hit, column, group):
    if column is None or column.get("kind") not in ("binary", "categorical"):
        return None
    if _count_level_ok(column, hit):
        return None
    return _signal(
        "raw_dataset_summary_mismatch", "D1", "raw-summary-mismatch", claim, dataset, column["name"],
        {"k": hit["groups"]["k"], "n": hit["groups"]["n"], "pct": hit["groups"]["pct"]},
        {"k": column.get("k"), "n": column.get("n"), "pct": column.get("pct"), "levels": column.get("levels")},
        group, "Recomputed count, denominator, or percent differs beyond rounding.",
    )


def _p_disagrees(computed, op, token):
    if computed is None or not math.isfinite(computed):
        return False
    decimals = psm.count_decimals(token)
    tolerance = 0.5 * (10 ** (-decimals)) + 1e-6
    reported = float(str(token).replace("−", "-"))
    if op == "=":
        return abs(computed - reported) > tolerance
    if op == "<":
        return computed >= reported + tolerance
    if op == "<=":
        return computed > reported + tolerance
    if op == ">":
        return computed <= reported - tolerance
    if op == ">=":
        return computed < reported - tolerance
    return False


def _test_for(dataset, variable):
    return next((test for test in dataset["tests"] if test["variable"] == variable), None)


def _both_disagree(test, op, token):
    if test["method"] == "t":
        pair = (test.get("welchP"), test.get("pooledP"))
    else:
        pair = (test.get("fisherP"), test.get("chi2P"))
    if any(value is None for value in pair):
        return False
    return all(_p_disagrees(value, op, token) for value in pair)


def _p_mismatch(dataset, claim, hit, variable):
    if _ADJUST_RE.search(claim["text"]):
        return None
    test = _test_for(dataset, variable)
    if test is None or not _both_disagree(test, hit["groups"]["op"], hit["groups"]["p"]):
        return None
    computed = {"welchP": test.get("welchP"), "pooledP": test.get("pooledP"), "fisherP": test.get("fisherP"), "chi2P": test.get("chi2P")}
    return _signal(
        "raw_dataset_p_mismatch", "D1", "raw-p-mismatch", claim, dataset, variable,
        {"op": hit["groups"]["op"], "p": hit["groups"]["p"]}, computed, None,
        "Reported unadjusted p disagrees with both applicable two-group tests.",
    )


def _stat_signals_for_claim(dataset, claim):
    if not _variables_in(dataset, claim["text"]):
        return []
    signals = []
    for hit in _pattern_hits(claim["text"]):
        variable = _bind_variable(dataset, claim["text"], hit["start"])
        if not variable:
            continue
        column, group = _scope_column(dataset, claim["text"], hit["start"], variable)
        if hit["kind"] == "p":
            signal = _p_mismatch(dataset, claim, hit, variable)
        else:
            signal = _summary_mismatch(dataset, claim, hit, column, group)
        if signal is not None:
            signals.append(signal)
    return signals


def _dedupe(signals):
    seen, unique = set(), []
    for signal in signals:
        key = (signal["kind"], signal.get("variable"), signal.get("group"), signal.get("pageIndex"), signal.get("excerpt"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(signal)
    return unique


def _number_signals(signals, max_signals):
    capped = signals[:max_signals]
    numbered = []
    for index, signal in enumerate(capped, start=1):
        numbered.append({"id": f"raw-{index}", **signal})
    return numbered, len(signals) > max_signals


def _collect_signals(datasets, claims):
    signals = []
    for dataset in datasets:
        for claim in claims:
            signals.extend(_n_signals_for_claim(dataset, claim))
            signals.extend(_stat_signals_for_claim(dataset, claim))
    return _dedupe(signals)


def _empty_report():
    return {
        "schema": SCHEMA,
        "status": "no_row_level_dataset",
        "datasetCount": 0,
        "signalCount": 0,
        "truncated": False,
        "signals": [],
        "datasets": [],
    }


def _public_dataset(dataset):
    return {key: dataset[key] for key in ("name", "rowCount", "analysisCount", "groupColumn", "groups", "overall", "tests", "flag")}


def audit_raw_datasets(page_items, supplements, *, table_items=None, max_signals=50):
    """Recompute row-level supplement statistics and compare them with the manuscript."""
    _validate_limit(max_signals)
    loaded = []
    for supp in supplements or []:
        if not isinstance(supp, dict):
            continue
        dataset = _dataset_rows(supp)
        if dataset is not None:
            loaded.append(dataset)
    if not loaded:
        return _empty_report()
    sole = len(loaded) == 1
    datasets = [_build_dataset(item["name"], item["rows"], sole) for item in loaded]
    claims = list(_iter_claims(page_items, table_items))
    numbered, truncated = _number_signals(_collect_signals(datasets, claims), max_signals)
    return {
        "schema": SCHEMA,
        "status": "ok",
        "datasetCount": len(datasets),
        "signalCount": len(numbered),
        "truncated": truncated,
        "signals": numbered,
        "datasets": [_public_dataset(dataset) for dataset in datasets],
    }
