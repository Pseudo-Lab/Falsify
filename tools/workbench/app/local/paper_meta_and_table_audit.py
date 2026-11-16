"""Deterministic PRISMA, meta-analysis, and cross-table sample-size audit.

Offline and network-free. Reuses paper_stat_math for the chi-square tail and
decimal places, and the evidence-store binding used by the other paper audits.
"""
import json
import math
import re

from paper_evidence_blue import require_summary
from paper_evidence_text import _require_bound_pdf, read_page_text
from paper_stat_math import count_decimals, gammaincc

SCHEMA = "falsify.meta-and-table-audit.v1"
_Z95 = 1.959964
_FORBIDDEN = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_FLOW_LABELS = (
    ("other", re.compile(
        r"additional\s+records?(?:\s+identified)?(?:\s+(?:from|through))?\s+"
        r"(?:citation\s+search(?:ing)?|other\s+sources?)"
        r"|records?\s+identified\s+(?:from|through)\s+(?:citation\s+search(?:ing)?|other\s+sources?)",
        re.I,
    )),
    ("identified", re.compile(r"records?\s+identified(?:\s+through\s+database\s+search(?:ing)?)?", re.I)),
    ("duplicates", re.compile(r"duplicates?\s+removed", re.I)),
    ("screened", re.compile(r"records?\s+(?:screened|after\s+duplicates?\s+removed)", re.I)),
    ("screen_excluded", re.compile(r"records?\s+excluded", re.I)),
    ("eligibility", re.compile(
        r"reports?\s+(?:sought|assessed)\s+for\s+eligibility"
        r"|full[- ]text\s+articles?\s+assessed\s+for\s+eligibility"
        r"|articles?\s+assessed\s+for\s+eligibility",
        re.I,
    )),
    ("fulltext_excluded", re.compile(r"full[- ]text(?:\s+articles?)?\s+excluded", re.I)),
    ("included", re.compile(
        r"studies?\s+included(?:\s+in\s+(?:the\s+)?(?:meta[- ]analysis|quantitative\s+synthesis|review))?",
        re.I,
    )),
)
_OTHER_MENTION = re.compile(r"citation\s+search(?:ing)?|other\s+sources|additional\s+records", re.I)
_NON_EXCLUSIVE = re.compile(r"not\s+mutually\s+exclusive|multiple\s+reasons", re.I)
_REASON_CUE = re.compile(r"reasons?\s+for\s+exclusion|exclusion\s+reasons?|excluded\s+because", re.I)
_REASON_N = re.compile(r"\(\s*[Nn]\s*=\s*(\d{1,7})\s*\)")
_COUNT_EQ = re.compile(r"[Nn]\s*=\s*(\d{1,3}(?:,\d{3})+|\d{1,7})")
_COUNT_BARE = re.compile(r"^\s*[:\-|]?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})\b")
_WEIGHT_HEADER = re.compile(r"weight|가중치", re.I)
_SUMMARY_ROW = re.compile(r"^\s*(?:total|overall|pooled|subtotal|subgroup|합계|전체)\b", re.I)
_PARTITION_ROW = re.compile(r"\b(?:subtotal|subgroup)\b", re.I)
_TOTAL_ROW = re.compile(r"^\s*(?:total|overall|pooled|합계|전체)\b", re.I)
_HUNDRED = re.compile(r"(?<!\d)100(?:\.0+)?\s*%?(?!\d)")
_EFFECT_HEADER = re.compile(r"\b(?:OR|RR|HR|IRR|MD|SMD|WMD|Difference|β|beta|Effect)\b|odds\s+ratio", re.I)
_LOW_HEADER = re.compile(r"\b(?:lower|lci|low)\b", re.I)
_HIGH_HEADER = re.compile(r"\b(?:upper|uci|high)\b", re.I)
_RATIO_SCALE = re.compile(r"\b(?:OR|RR|HR|IRR)\b|odds\s+ratio|risk\s+ratio|hazard\s+ratio", re.I)
_DIFF_SCALE = re.compile(r"\b(?:MD|SMD|WMD|differences?)\b|β|\bbeta\b", re.I)
_FIXED = re.compile(r"fixed[\s-]?effects?|common[\s-]?effect|inverse[\s-]?variance", re.I)
_RANDOM = re.compile(r"random[\s-]?effects?|der\s*simonian", re.I)
_POOL_EXEMPT = re.compile(
    r"network\s+meta-analysis|bayesian|hierarchical\s+priors?|meta-regression|multivariable",
    re.I,
)
_POOLED_LABEL = re.compile(r"^\s*(?:total|overall|pooled|합계|전체)\b", re.I)
_SKIP_LABEL = re.compile(r"^\s*(?:subtotal|subgroup)\b", re.I)
_COMBINED_RE = re.compile(
    r"(?P<est>[-+]?\d+(?:\.\d+)?)\s*[\(\[]\s*(?P<lo>[-+]?\d+(?:\.\d+)?)\s*"
    r"(?:,|to|–|—|-)\s*(?P<hi>[-+]?\d+(?:\.\d+)?)\s*[\)\]]",
    re.I,
)
_I2_RE = re.compile(r"(?<![A-Za-z])I(?:\s*\^?\s*2|²)\s*=\s*(\d+(?:\.\d+)?)\s*%", re.I)
_Q_RE = re.compile(
    r"(?<![A-Za-z])(?:cochran'?s?\s+q|q|χ\s*\^?\s*2|χ²|chi\s*\^?\s*2|chi-square)\s*=\s*(\d+(?:\.\d+)?)",
    re.I,
)
_DF_RE = re.compile(r"(?<![A-Za-z])df\s*=\s*(\d+(?:\.\d+)?)", re.I)
_K_RE = re.compile(r"(?<![A-Za-z])k\s*=\s*(\d+)\s+studies\b", re.I)
_PHET_RE = re.compile(
    r"p\s*(?:_?\s*het|for\s+heterogeneity)\s*(?P<op>=|<|≤)\s*(?P<p>\d*\.?\d+)",
    re.I,
)
_TUPLE_P_RE = re.compile(
    r"q\s*=\s*\d+(?:\.\d+)?\s*,\s*df\s*=\s*\d+(?:\.\d+)?\s*,\s*p\s*(?P<op>=|<|≤)\s*(?P<p>\d*\.?\d+)",
    re.I,
)
_NEAR_P_RE = re.compile(
    r"df\s*=\s*\d+(?:\.\d+)?.{0,40}?\bp\s*(?P<op>=|<|≤)\s*(?P<p>\d*\.?\d+)",
    re.I,
)
_ARM_RE = re.compile(
    r"(?P<label>[A-Za-z][A-Za-z0-9+\-/]*)\s*\(\s*[Nn]\s*=\s*(?P<n>\d{1,7})\s*\)",
)
_SUBSET = re.compile(
    r"per-protocol|per protocol|completer|subgroup|safety|modified\s+itt|\bmitt\b|"
    r"biomarker\s+subset|available|missing|하위군|완료자",
    re.I,
)
_FLOW_KEYS = (
    "identified", "duplicates", "screened", "screen_excluded", "eligibility",
    "fulltext_excluded", "included", "other",
)


def _assert_no_red_keys(value):
    if isinstance(value, dict):
        _reject_red_dict(value)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _assert_no_red_keys(item)


def _reject_red_dict(value):
    for key, item in value.items():
        if key in _FORBIDDEN:
            raise ValueError("forbidden_red_key")
        _assert_no_red_keys(item)


def _validate_limit(max_signals):
    if type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")


def _default_store():
    from paper_evidence import default_store
    return default_store


def _page(page_index, text):
    return {"pageIndex": page_index, "text": text}


def _page_index(value, fallback):
    if type(value) is int:
        return value
    return fallback


def _page_record(item, idx):
    if isinstance(item, str):
        return [_page(idx, item)]
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        return [_page(_page_index(item[0], idx), str(item[1]))]
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        return [_page(_page_index(item.get("pageIndex", idx), idx), item["text"])]
    return []


def _normalize_pages(page_items):
    if page_items is None:
        return []
    if isinstance(page_items, str):
        page_items = [page_items]
    if not isinstance(page_items, (list, tuple)):
        return []
    pages = []
    for idx, item in enumerate(page_items):
        pages.extend(_page_record(item, idx))
    return pages


def _normalize_tables(table_items):
    if not isinstance(table_items, (list, tuple)):
        return []
    tables = []
    for item in table_items:
        if isinstance(item, dict):
            tables.append(item)
    return tables


def _excerpt(text):
    return " ".join(str(text or "").split())[:220]


def _signal(kind, subtype, page_index, excerpt, reported, computed, detail):
    return {
        "family": "D1",
        "kind": kind,
        "subtype": subtype,
        "pageIndex": page_index,
        "excerpt": _excerpt(excerpt),
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }


def _page_of(item):
    page = item.get("pageIndex", 0) if isinstance(item, dict) else 0
    if type(page) is int:
        return page
    return 0


def _span_used(span, occupied):
    start, end = span
    for lo, hi in occupied:
        if start < hi and end > lo:
            return True
    return False


def _count_after(text, end):
    segment = text[end:end + 48]
    match = _COUNT_EQ.search(segment)
    if match:
        return int(match.group(1).replace(",", ""))
    match = _COUNT_BARE.search(segment)
    if match:
        return int(match.group(1).replace(",", ""))
    return None


def _take_label(text, key, pattern, found, occupied):
    for match in pattern.finditer(text):
        if _span_used(match.span(), occupied):
            continue
        occupied.append(match.span())
        if key in found:
            continue
        count = _count_after(text, match.end())
        if count is None:
            continue
        found[key] = count


def _flow_counts(text):
    found, occupied = {}, []
    for key, pattern in _FLOW_LABELS:
        _take_label(text, key, pattern, found, occupied)
    if _OTHER_MENTION.search(text or ""):
        found["other_mentioned"] = True
    return found


def _label_count(counts):
    return sum(1 for key in _FLOW_KEYS if key in counts)


def _prisma_signal(page, detail, reported, computed):
    return _signal(
        "prisma_flow_mismatch", "prisma-flow-arithmetic", page["pageIndex"],
        page["text"], reported, computed, detail,
    )


def _increase_issue(counts, page, bad, detail, reported):
    if counts.get("other_mentioned") or not bad:
        return []
    return [_prisma_signal(page, detail, reported, {"impossibleIncrease": True})]


def _screen_equation(counts, page, identified, duplicates, screened):
    mentioned = bool(counts.get("other_mentioned"))
    other = counts.get("other")
    if mentioned and other is None:
        return []
    extra = other or 0
    expected = identified + extra - duplicates
    if screened == expected:
        return []
    reported = {
        "identified": identified, "duplicates": duplicates, "other": extra, "screened": screened,
    }
    return [_prisma_signal(
        page, "identified - duplicates = screened", reported, {"expectedScreened": expected},
    )]


def _screen_issue(counts, page):
    identified = counts.get("identified")
    screened = counts.get("screened")
    if identified is None or screened is None:
        return []
    duplicates = counts.get("duplicates")
    if duplicates is None:
        return _increase_issue(
            counts, page, screened > identified, "screened exceeds identified",
            {"identified": identified, "screened": screened},
        )
    return _screen_equation(counts, page, identified, duplicates, screened)


def _elig_issue(counts, page):
    screened = counts.get("screened")
    eligibility = counts.get("eligibility")
    if screened is None or eligibility is None:
        return []
    excluded = counts.get("screen_excluded")
    if excluded is None:
        return _increase_issue(
            counts, page, eligibility > screened, "eligibility exceeds screened",
            {"screened": screened, "eligibility": eligibility},
        )
    expected = screened - excluded
    if eligibility == expected:
        return []
    return [_prisma_signal(
        page, "screened - excluded = eligibility",
        {"screened": screened, "excluded": excluded, "eligibility": eligibility},
        {"expectedEligibility": expected},
    )]


def _inc_issue(counts, page):
    eligibility = counts.get("eligibility")
    included = counts.get("included")
    if eligibility is None or included is None:
        return []
    excluded = counts.get("fulltext_excluded")
    if excluded is None:
        return _increase_issue(
            counts, page, included > eligibility, "included exceeds eligibility",
            {"eligibility": eligibility, "included": included},
        )
    expected = eligibility - excluded
    if included == expected:
        return []
    return [_prisma_signal(
        page, "eligibility - full-text excluded = included",
        {"eligibility": eligibility, "fulltextExcluded": excluded, "included": included},
        {"expectedIncluded": expected},
    )]


def _headline_reconciles(counts):
    eligibility = counts.get("eligibility")
    excluded = counts.get("fulltext_excluded")
    included = counts.get("included")
    if None in (eligibility, excluded, included):
        return False
    return eligibility - excluded == included


def _reason_counts(text):
    match = _REASON_CUE.search(text or "")
    if match is None:
        return []
    window = text[match.end():match.end() + 500]
    return [int(token) for token in _REASON_N.findall(window)]


def _reason_issue(counts, page):
    text = page["text"]
    if _NON_EXCLUSIVE.search(text or ""):
        return []
    if _headline_reconciles(counts):
        return []
    excluded = counts.get("fulltext_excluded")
    reasons = _reason_counts(text)
    if excluded is None or len(reasons) < 2 or sum(reasons) == excluded:
        return []
    return [_prisma_signal(
        page, "full-text exclusion reasons do not sum to the excluded count",
        {"fulltextExcluded": excluded, "reasonSum": sum(reasons), "reasons": reasons},
        {"expectedReasonSum": excluded},
    )]


def _prisma_page(page):
    counts = _flow_counts(page["text"])
    signals = []
    if _label_count(counts) >= 2:
        signals.extend(_screen_issue(counts, page))
        signals.extend(_elig_issue(counts, page))
        signals.extend(_inc_issue(counts, page))
    signals.extend(_reason_issue(counts, page))
    return signals


def _nearest(pattern, text, anchor):
    best, dist = None, None
    for match in pattern.finditer(text or ""):
        delta = abs(match.start() - anchor)
        if dist is None or delta < dist:
            best, dist = match, delta
    return best


def _nearest_within(pattern, text, anchor, limit):
    match = _nearest(pattern, text, anchor)
    if match is None or abs(match.start() - anchor) > limit:
        return None
    return match


def _p_parts(match):
    op = "<" if match.group("op") == "≤" else match.group("op")
    return op, float(match.group("p")), match.group("p")


def _df_near(text, anchor):
    df_match = _nearest_within(_DF_RE, text, anchor, 500)
    if df_match is not None:
        return float(df_match.group(1))
    k_match = _nearest_within(_K_RE, text, anchor, 500)
    if k_match is not None:
        return float(int(k_match.group(1)) - 1)
    return None


def _p_near(text, anchor):
    for pattern, limit in ((_PHET_RE, 700), (_TUPLE_P_RE, 500), (_NEAR_P_RE, 80)):
        match = _nearest_within(pattern, text, anchor, limit)
        if match is not None:
            return _p_parts(match)
    return None


def _parse_het(text, match):
    q_match = _nearest_within(_Q_RE, text, match.start(), 500)
    if q_match is None:
        return None
    df = _df_near(text, match.start())
    if df is None:
        return None
    p_info = _p_near(text, match.start())
    i2 = float(match.group(1))
    q = float(q_match.group(1))
    p_token = None if p_info is None else p_info[2]
    return {
        "q": q, "df": df, "i2": i2, "p": p_info,
        "key": (q, df, i2, p_token),
    }


def _snippet(text, start, end):
    lo = max(0, start - 90)
    hi = min(len(text), end + 90)
    return text[lo:hi]


def _i2_issue(parsed, page_index, excerpt):
    q = parsed["q"]
    if q <= 0:
        return None
    expected = max(0.0, (q - parsed["df"]) / q * 100.0)
    if abs(expected - parsed["i2"]) <= 2.5:
        return None
    return _signal(
        "meta_heterogeneity_mismatch", "cochran-q-i2", page_index, excerpt,
        {"Q": q, "df": parsed["df"], "I2": parsed["i2"]},
        {"I2": round(expected, 4)},
        f"I2 expected {expected:.1f} from Q={q} df={parsed['df']}, reported {parsed['i2']}",
    )


def _p_gross(parsed, expected, p_info):
    op, p_value, token = p_info
    if op in ("<",) and parsed["q"] < parsed["df"] and p_value < 0.01:
        return True
    if op != "=":
        return False
    tol = max(0.02, 0.5 * (10 ** (-count_decimals(token))))
    if parsed["q"] < parsed["df"] and p_value < 0.01:
        return True
    return abs(expected - p_value) > tol


def _p_issue(parsed, page_index, excerpt):
    p_info = parsed["p"]
    if p_info is None or parsed["df"] < 1 or parsed["q"] < 0:
        return None
    expected = gammaincc(parsed["df"] / 2.0, parsed["q"] / 2.0)
    if not _p_gross(parsed, expected, p_info):
        return None
    op, p_value, _token = p_info
    return _signal(
        "meta_heterogeneity_mismatch", "cochran-q-i2", page_index, excerpt,
        {"Q": parsed["q"], "df": parsed["df"], "p": p_value, "operator": op},
        {"p": round(expected, 6)},
        f"heterogeneity p expected {expected:.4f} from Q={parsed['q']} df={parsed['df']}, reported {op} {p_value}",
    )


def _het_issues(parsed, page_index, excerpt):
    signals = []
    i2_signal = _i2_issue(parsed, page_index, excerpt)
    if i2_signal is not None:
        signals.append(i2_signal)
    p_signal = _p_issue(parsed, page_index, excerpt)
    if p_signal is not None:
        signals.append(p_signal)
    return signals


def _heterogeneity_text(text, page_index):
    signals, seen = [], set()
    for match in _I2_RE.finditer(text or ""):
        parsed = _parse_het(text, match)
        if parsed is None or parsed["key"] in seen:
            continue
        seen.add(parsed["key"])
        signals.extend(_het_issues(parsed, page_index, _snippet(text, match.start(), match.end())))
    return signals


def _rows_of(item):
    if not isinstance(item, dict):
        return []
    table = item.get("table") if isinstance(item.get("table"), dict) else item
    if not isinstance(table, dict):
        return []
    matrix = _row_matrix(table.get("rows"))
    if matrix:
        return matrix
    if isinstance(item.get("rows"), list):
        matrix = _row_matrix(item.get("rows"))
        if matrix:
            return matrix
    cells = table.get("cells")
    if isinstance(cells, list):
        return _cells_to_rows(cells)
    return []


def _row_matrix(rows):
    if not isinstance(rows, list) or not rows:
        return []
    matrix = []
    for row in rows:
        if not isinstance(row, (list, tuple)):
            return []
        matrix.append([str(cell) for cell in row])
    return matrix


def _cells_to_rows(cells):
    grouped = {}
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        row, col = cell.get("row", 0), cell.get("column", 0)
        if type(row) is not int or type(col) is not int:
            continue
        grouped.setdefault(row, []).append((col, str(cell.get("text") or "")))
    return [_ordered_row(grouped[key]) for key in sorted(grouped)]


def _ordered_row(pairs):
    return [text for _col, text in sorted(pairs)]


def _render_rows(rows):
    return "\n".join(" | ".join(row) for row in rows)


def _find_header(rows, pattern):
    for index, row in enumerate(rows[:3]):
        if pattern.search(" ".join(row)):
            return index
    return None


def _column_index(header, pattern):
    for index, cell in enumerate(header):
        if pattern.search(cell):
            return index
    return None


def _cell_weight(row, index):
    if index >= len(row):
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*%?", row[index].strip().replace(",", ""))
    if match is None:
        return None
    return float(match.group(1))


def _row_claims_100(row):
    label = row[0] if row else ""
    if _TOTAL_ROW.search(label) is None:
        return False
    for cell in row:
        if _HUNDRED.search(cell):
            return True
    return False


def _weight_stats(rows, index):
    total, studies = 0.0, 0
    partition, claims = False, False
    for row in rows:
        label = row[0] if row else ""
        if _PARTITION_ROW.search(label):
            partition = True
        if _row_claims_100(row):
            claims = True
        if _SUMMARY_ROW.search(label):
            continue
        value = _cell_weight(row, index)
        if value is None:
            continue
        total += value
        studies += 1
    return {"total": total, "studies": studies, "partition": partition, "claims100": claims}


def _weight_audit(rows, page_index, excerpt):
    header_at = _find_header(rows, _WEIGHT_HEADER)
    if header_at is None:
        return []
    column = _column_index(rows[header_at], _WEIGHT_HEADER)
    if column is None:
        return []
    stats = _weight_stats(rows[header_at + 1:], column)
    if stats["studies"] < 2:
        return []
    if stats["partition"] and not stats["claims100"]:
        return []
    if abs(stats["total"] - 100.0) <= 1.5:
        return []
    return [_signal(
        "meta_weight_sum_mismatch", "forest-weight-sum", page_index, excerpt,
        {"weightSum": round(stats["total"], 4), "studyRows": stats["studies"]},
        {"expected": 100.0, "tolerance": 1.5},
        f"study weights sum to {stats['total']:.2f}, expected 100",
    )]


def _put_role(roles, name, index):
    if index is not None:
        roles[name] = index


def _effect_roles(header):
    roles = {}
    _put_role(roles, "effect", _column_index(header, _EFFECT_HEADER))
    _put_role(roles, "lo", _column_index(header, _LOW_HEADER))
    _put_role(roles, "hi", _column_index(header, _HIGH_HEADER))
    return roles


def _plain_float(text):
    cleaned = str(text).strip().replace(",", "").replace("−", "-").replace("%", "")
    if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", cleaned) is None:
        return None
    return float(cleaned)


def _triple_estimate(row, roles):
    needed = ("effect", "lo", "hi")
    if any(name not in roles for name in needed):
        return None
    est = _plain_float(row[roles["effect"]]) if roles["effect"] < len(row) else None
    lo = _plain_float(row[roles["lo"]]) if roles["lo"] < len(row) else None
    hi = _plain_float(row[roles["hi"]]) if roles["hi"] < len(row) else None
    if None in (est, lo, hi):
        return None
    return est, lo, hi, row[roles["effect"]].strip()


def _combined_tuple(match):
    return (
        float(match.group("est")), float(match.group("lo")), float(match.group("hi")),
        match.group("est"),
    )


def _scan_row_estimate(row):
    for cell in row:
        match = _COMBINED_RE.search(str(cell))
        if match is not None:
            return _combined_tuple(match)
    return None


def _effect_only(row, roles):
    if "effect" not in roles or roles["effect"] >= len(row):
        return None
    est = _plain_float(row[roles["effect"]])
    if est is None:
        return None
    return est, None, None, row[roles["effect"]].strip()


def _row_estimate(row, roles):
    triple = _triple_estimate(row, roles)
    if triple is not None:
        return triple
    combined = _scan_row_estimate(row)
    if combined is not None:
        return combined
    return _effect_only(row, roles)


def _split_effects(rows, roles):
    studies, summary = [], None
    for row in rows:
        label = row[0] if row else ""
        if _SKIP_LABEL.search(label):
            continue
        parsed = _row_estimate(row, roles)
        if parsed is None:
            continue
        if _POOLED_LABEL.search(label):
            summary = parsed
        elif parsed[1] is not None and parsed[2] is not None:
            studies.append(parsed)
    return studies, summary


def _nonpositive_ratio(ratio, est, lo, hi):
    if not ratio:
        return False
    return est <= 0 or lo <= 0 or hi <= 0


def _analysis_point(study, ratio):
    est, lo, hi = study[0], study[1], study[2]
    if lo is None or hi is None:
        return None
    if _nonpositive_ratio(ratio, est, lo, hi):
        return None
    if ratio:
        est, lo, hi = math.log(est), math.log(lo), math.log(hi)
    if hi <= lo:
        return None
    se = (hi - lo) / (2 * _Z95)
    if se <= 0:
        return None
    return est, se


def _tau2(q, df, c):
    if c > 0 and df > 0 and q > df:
        return (q - df) / c
    return 0.0


def _fe_re(ys, ses):
    ws = [1.0 / (se * se) for se in ses]
    sw = sum(ws)
    if sw <= 0:
        return None
    theta_fe = sum(w * y for w, y in zip(ws, ys)) / sw
    q = sum(w * (y - theta_fe) ** 2 for w, y in zip(ws, ys))
    tau2 = _tau2(q, len(ys) - 1, sw - sum(w * w for w in ws) / sw)
    wstar = [1.0 / (se * se + tau2) for se in ses]
    sws = sum(wstar)
    if sws <= 0:
        return None
    theta_re = sum(w * y for w, y in zip(wstar, ys)) / sws
    return theta_fe, theta_re


def _inverse_variance(studies, ratio):
    points = []
    for study in studies:
        point = _analysis_point(study, ratio)
        if point is None:
            return None
        points.append(point)
    return _fe_re([point[0] for point in points], [point[1] for point in points])


def _scale_ratio(text):
    if _RATIO_SCALE.search(text):
        return True
    if _DIFF_SCALE.search(text):
        return False
    return None


def _fixed_stated(text):
    if _RANDOM.search(text):
        return False
    return _FIXED.search(text) is not None


def _pool_context(table, header, page_text):
    caption = str(table.get("caption") or "")
    return "\n".join([caption, " ".join(header), page_text or ""])


def _effect_tol(token):
    half = 0.5 * (10 ** (-count_decimals(token)))
    return max(0.05, 2.5 * half)


def _report_scale(pooled, ratio):
    fe, re = pooled
    if ratio:
        return math.exp(fe), math.exp(re)
    return fe, re


def _pool_signal(page_index, excerpt, reported, fe_s, re_s, tol, reason):
    return _signal(
        "meta_pooled_effect_mismatch", "inverse-variance-pooled", page_index, excerpt,
        {"effect": reported, "model": reason},
        {"fixedEffect": round(fe_s, 6), "randomEffect": round(re_s, 6), "tolerance": tol},
        f"pooled effect {reported} disagrees with inverse-variance estimates ({reason})",
    )


def _fixed_conflict(context, reported, fe_s, tol):
    if not _fixed_stated(context):
        return False
    return abs(reported - fe_s) > tol


def _outside(reported, studies, tol):
    values = [item[0] for item in studies]
    low, high = min(values), max(values)
    if reported < low - tol:
        return True
    return reported > high + tol


def _hull_conflict(reported, studies, fe_s, re_s, tol):
    if abs(reported - fe_s) <= tol or abs(reported - re_s) <= tol:
        return False
    return _outside(reported, studies, tol)


def _pool_decision(summary, pooled, studies, ratio, context, page_index, excerpt):
    fe_s, re_s = _report_scale(pooled, ratio)
    reported, token = summary[0], summary[3]
    tol = _effect_tol(token)
    if _fixed_conflict(context, reported, fe_s, tol):
        return [_pool_signal(page_index, excerpt, reported, fe_s, re_s, tol, "fixed-effect")]
    if _hull_conflict(reported, studies, fe_s, re_s, tol):
        return [_pool_signal(page_index, excerpt, reported, fe_s, re_s, tol, "convex-hull")]
    return []


def _pooled_from_rows(rows, table, page_text, page_index):
    header_at = _find_header(rows, _EFFECT_HEADER)
    if header_at is None:
        return []
    context = _pool_context(table, rows[header_at], page_text)
    if _POOL_EXEMPT.search(context):
        return []
    ratio = _scale_ratio(context)
    if ratio is None:
        return []
    studies, summary = _split_effects(rows[header_at + 1:], _effect_roles(rows[header_at]))
    if len(studies) < 2 or summary is None:
        return []
    pooled = _inverse_variance(studies, ratio)
    if pooled is None:
        return []
    return _pool_decision(summary, pooled, studies, ratio, context, page_index, _render_rows(rows))


def _split_pipe(line):
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _split_gaps(line):
    return [cell.strip() for cell in re.split(r"\s{2,}", line.strip()) if cell.strip()]


def _split_row(line):
    if "|" in line:
        return _split_pipe(line)
    return _split_gaps(line)


def _is_table_line(line):
    if "|" in line:
        return True
    return bool(re.search(r"\S\s{2,}\S", line))


def _flush_text_table(rows, page_index):
    if len(rows) < 3:
        return []
    header = " ".join(rows[0])
    if _WEIGHT_HEADER.search(header) is None and _EFFECT_HEADER.search(header) is None:
        return []
    return [{
        "pageIndex": page_index, "caption": "", "rows": [list(row) for row in rows],
        "synthetic": True, "id": f"text-{page_index}",
    }]


def _text_tables(text, page_index):
    rows, tables = [], []
    for line in (text or "").splitlines():
        cells = _split_row(line) if _is_table_line(line) else None
        if cells and len(cells) >= 2:
            rows.append(cells)
            continue
        tables.extend(_flush_text_table(rows, page_index))
        rows = []
    tables.extend(_flush_text_table(rows, page_index))
    return tables


def _tables_from_pages(pages):
    found = []
    for page in pages:
        found.extend(_text_tables(page["text"], page["pageIndex"]))
    return found


def _all_tables(pages, tables):
    merged = list(tables)
    merged.extend(_tables_from_pages(pages))
    return merged


def _page_map(pages):
    blob = {}
    for page in pages:
        blob[page["pageIndex"]] = blob.get(page["pageIndex"], "") + "\n" + page["text"]
    return blob


def _table_blob(table, rendered):
    return "\n".join([str(table.get("caption") or ""), rendered])


def _one_table(table, page_text):
    rows = _rows_of(table)
    if not rows:
        return []
    page = _page_of(table)
    rendered = _render_rows(rows)
    signals = _weight_audit(rows, page, rendered)
    signals.extend(_pooled_from_rows(rows, table, page_text, page))
    if rendered not in (page_text or ""):
        signals.extend(_heterogeneity_text(rendered, page))
        signals.extend(_prisma_page({"pageIndex": page, "text": _table_blob(table, rendered)}))
    return signals


def _arm_key(label):
    return re.sub(r"[^a-z0-9]+", "", label.lower())


def _marked_headers(item):
    table = item.get("table") if isinstance(item.get("table"), dict) else {}
    cells = table.get("cells") if isinstance(table, dict) else None
    if not isinstance(cells, list):
        return ""
    texts = []
    for cell in cells:
        if isinstance(cell, dict) and cell.get("header") is True:
            texts.append(str(cell.get("text") or ""))
    return " ".join(texts)


def _caption_and_headers(item):
    parts = [str(item.get("caption") or "")]
    for row in _rows_of(item)[:2]:
        parts.append(" ".join(row))
    parts.append(_marked_headers(item))
    return "\n".join(parts)


def _table_text(item):
    parts = [str(item.get("caption") or "")]
    for row in _rows_of(item):
        parts.append(" ".join(row))
    return "\n".join(parts)


def _table_has_subset(item):
    return _SUBSET.search(_table_text(item)) is not None


def _table_arms(item):
    if item.get("synthetic") or _table_has_subset(item):
        return {}
    arms = {}
    for match in _ARM_RE.finditer(_caption_and_headers(item)):
        key = _arm_key(match.group("label"))
        if len(key) < 3 or key in arms:
            continue
        arms[key] = int(match.group("n"))
    return arms


def _arm_phrase(table, key):
    for match in _ARM_RE.finditer(_caption_and_headers(table)):
        if _arm_key(match.group("label")) == key:
            return match.group(0)
    return key


def _arm_report(table, n):
    return {
        "id": table.get("id") or table.get("itemId"),
        "pageIndex": _page_of(table),
        "n": n,
        "caption": _excerpt(table.get("caption") or ""),
    }


def _conflict_signal(key, first, second):
    table_a, n_a = first
    table_b, n_b = second
    return _signal(
        "cross_table_sample_size_mismatch", "table-to-table-n", _page_of(table_b),
        f"{_arm_phrase(table_a, key)} vs {_arm_phrase(table_b, key)}",
        {"arm": key, "tables": [_arm_report(table_a, n_a), _arm_report(table_b, n_b)]},
        {"sameCohort": True},
        f"{key} N differs across tables ({n_a} vs {n_b})",
    )


def _arm_conflicts(keyed):
    first, signals, emitted = {}, [], set()
    for table, arms in keyed:
        for key, n in arms.items():
            if key not in first:
                first[key] = (table, n)
                continue
            if n != first[key][1] and key not in emitted:
                signals.append(_conflict_signal(key, first[key], (table, n)))
                emitted.add(key)
    return signals


def _cross_signals(tables):
    keyed = []
    for table in tables:
        arms = _table_arms(table)
        if arms:
            keyed.append((table, arms))
    if len(keyed) < 2:
        return []
    return _arm_conflicts(keyed)


def _collect(pages, tables):
    merged = _all_tables(pages, tables)
    page_text = _page_map(pages)
    signals = []
    for page in pages:
        signals.extend(_prisma_page(page))
        signals.extend(_heterogeneity_text(page["text"], page["pageIndex"]))
    for table in merged:
        signals.extend(_one_table(table, page_text.get(_page_of(table), "")))
    signals.extend(_cross_signals(merged))
    return signals


def _dedupe_key(sig):
    reported = json.dumps(sig["reported"], sort_keys=True, ensure_ascii=False)
    return (sig["kind"], sig["subtype"], sig["pageIndex"], reported)


def _dedupe(signals):
    seen, unique = set(), []
    for sig in signals:
        key = _dedupe_key(sig)
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    return unique


def _finish(signals, max_signals):
    unique = _dedupe(signals)
    capped = unique[:max_signals]
    numbered = [{"id": f"mta-{index + 1}", **sig} for index, sig in enumerate(capped)]
    return {
        "schema": SCHEMA,
        "status": "ok",
        "signalCount": len(numbered),
        "truncated": len(unique) > max_signals,
        "signals": numbered,
    }


def audit_meta_and_tables(page_items, *, table_items=None, max_signals=30):
    """Audit PRISMA flow, meta-analysis arithmetic, and cross-table denominators."""
    _validate_limit(max_signals)
    _assert_no_red_keys(page_items)
    _assert_no_red_keys(table_items)
    pages = _normalize_pages(page_items)
    tables = _normalize_tables(table_items)
    return _finish(_collect(pages, tables), max_signals)


def _one_page_text(store, paper_id, page_index):
    try:
        page = read_page_text(paper_id, page_index, section_only=False, store=store)
    except ValueError as exc:
        if exc.args == ("paper_evidence_source_unavailable",):
            return None
        raise
    return page.get("text") or ""


def _read_pages(store, paper_id, page_count):
    pages = []
    for page_index in range(min(page_count, 80)):
        text = _one_page_text(store, paper_id, page_index)
        if text is None:
            return []
        pages.append(_page(page_index, text))
    return pages


def _more_items(batch, nxt, offset):
    if not batch or nxt is None:
        return False
    if type(nxt) is not int or nxt <= offset:
        return False
    return True


def _append_tables(items, store, paper_id, file_hash, batch):
    for meta in batch:
        if not isinstance(meta, dict) or not meta.get("id"):
            continue
        item = store.read_item(paper_id, meta["id"])
        if item.get("fileHash") not in (None, file_hash):
            raise ValueError("paper_evidence_hash_mismatch")
        if item.get("type") == "table":
            items.append(item)


def _read_tables(store, paper_id, file_hash):
    items, offset = [], 0
    for _ in range(10000):
        page = store.list_items(paper_id, kind="table", page_index=None, offset=offset, limit=50)
        batch = page.get("items") or []
        _append_tables(items, store, paper_id, file_hash, batch)
        nxt = page.get("nextOffset")
        if not _more_items(batch, nxt, offset):
            break
        offset = nxt
    return items


def _load_paper(paper_id, file_hash, store):
    store = _default_store() if store is None else store
    paper_id, actual_hash, summary, _raw = _require_bound_pdf(paper_id, store)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)
    return {
        "paperId": paper_id,
        "fileHash": actual_hash,
        "pages": _read_pages(store, paper_id, summary["pageCount"]),
        "tables": _read_tables(store, paper_id, actual_hash),
    }


def audit_paper_meta_and_tables(paper_id, file_hash=None, *, max_signals=30, store=None):
    """Bind a prepared PDF and audit its page text plus stored tables."""
    _validate_limit(max_signals)
    bound = _load_paper(paper_id, file_hash, store)
    report = audit_meta_and_tables(bound["pages"], table_items=bound["tables"], max_signals=max_signals)
    _assert_no_red_keys(report)
    return {**report, "paperId": bound["paperId"], "fileHash": bound["fileHash"]}
