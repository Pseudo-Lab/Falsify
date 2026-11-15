"""Deterministic paper-wide arithmetic, statistical, and cross-modal pre-audit."""
import re

from paper_evidence_blue import require_summary
from paper_stat_math import (
    check_ci_bounds,
    check_count_percentage,
    check_grim,
    check_km_at_risk,
    check_sprite,
    check_stat_pvalue,
    check_two_by_two,
    count_decimals,
)

SCHEMA = "falsify.paper-stat-audit.v1"
DISCLAIMER = (
    "Deterministic arithmetic/statistical pre-check candidates only; verify subgroup scope, "
    "weighting, covariates, and one/two-tailed conventions in source text before concluding a defect."
)
MAX_AUDIT_PAGES = 80
_NUM = r"[-−]?\d+(?:\.\d+)?"
_P_MOD = (
    r"(?i:(?:bonferroni|fdr|holm|hochberg|benjamini|tukey|sidak|šidák|dunnett|scheffe|scheffé|"
    r"games|howell|adjusted|adj\.?|corrected|unadjusted|raw|nominal|exact|two|one|tailed|bh|fwer|"
    r"multiple|comparisons?|testing|보정된?|다중비교|다중검정)[-\s,]*){0,6}"
)
_P_TAIL = rf"[,;:\(\s]*(?:{_P_MOD})?\b(?:[pP](?:[_-]?adj)?|[qQ](?:[- ]?value)?)\s*(?P<op>=|<|<=|>|>=|≤|≥)\s*(?P<p>\d*\.?\d+(?:[eE][-−+]?\d+)?)"
_T_PAREN_RE = re.compile(rf"\bt\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<val>{_NUM})\s*{_P_TAIL}")
_T_COMMA_RE = re.compile(rf"\bt\s*=\s*(?P<val>{_NUM})\s*,\s*df\s*=\s*(?P<df1>\d+(?:\.\d+)?)\s*{_P_TAIL}", re.I)
_F_RE = re.compile(rf"\bF\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*,\s*(?P<df2>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<val>{_NUM})\s*{_P_TAIL}")
_CHI_RE = re.compile(
    rf"(?:χ2|χ²|chi2|chi\^2|chi-square)\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*(?:,\s*[Nn]\s*=\s*\d+)?\s*\)\s*=\s*(?P<val>{_NUM})\s*{_P_TAIL}",
    re.I,
)
_Z_RE = re.compile(rf"\bz\s*=\s*(?P<val>{_NUM})\s*{_P_TAIL}")
_PCT_RE = re.compile(r"(?<![\d.])(?P<count>\d{1,7})\s*/\s*(?P<total>\d{1,7})\s*\(\s*(?P<pct>\d+(?:\.\d+)?)\s*%\s*\)")
_CELL_PCT_RE = re.compile(r"^\s*(?P<count>\d{1,7})\s*\(\s*(?P<pct>\d+(?:\.\d+)?)\s*%?\s*\)\s*$")
_CI_SEP = r"(?:\s*,\s*|\s+to\s+|\s*[–—]\s*|\s+-\s+|(?<=\d)-(?=[-−]?\d))"
_CI_EXPR_RE = re.compile(
    rf"(?:(?P<kind>a?OR|a?RR|a?HR|IRR|mean|beta|β|diff(?:erence)?|effect)\s*(?:=|:)?\s*)?"
    rf"(?P<est>{_NUM})\s*[\(\[]\s*(?P<tag>9\d%?\s*CI\s*[:=,]?\s*)?(?P<lo>{_NUM}){_CI_SEP}(?P<hi>{_NUM})\s*[\)\]]",
    re.I,
)
_MEAN_RE = re.compile(r"\b(?:mean|M)\s*(?:\(\s*SD\s*\))?\s*=\s*(?P<mean>[-−]?\d+\.\d+)", re.I)
_N_EQ_RE = re.compile(r"\b[Nn]\s*=\s*(?P<n>\d{1,6})\b")
_ITEM_COUNT_RE = re.compile(r"\b(?P<items>\d{1,2})[- ]items?\b", re.I)
_CONT_UNIT_RE = re.compile(r"\b(?:kg|mg|cm|mm|mmhg|years?|age|bmi|seconds?|minutes?|hours?|ms|hz|ml|mmol|%)\b", re.I)
_PLAIN_NUM_RE = re.compile(r"^\s*[-−]?\d+(?:,\d{3})*(?:\.\d+)?\s*$")
_TOTAL_LABEL_RE = re.compile(r"^\s*(?:total|sum)\b", re.I)
_N_HEADER_RE = re.compile(r"\b[Nn]\s*=\s*(\d{1,7})\b")
_REF_TABLE_RE = re.compile(r"\bTable\s+(?P<label>\d+[A-Za-z]?)\b", re.I)
_REF_FIG_RE = re.compile(r"\b(?:Figure|Fig\.?)\s+(?P<label>\d+[A-Za-z]?)\b", re.I)
_CAPTION_START_RE = re.compile(r"^\s*(?:Table|Figure|Fig\.?)\s+\d+[A-Za-z]?\s*[:.\-]", re.I)
_INLINE_PCT_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)\s*%")
_INLINE_P_RE = re.compile(r"\b[pP]\s*(=|<|<=|>|>=|≤|≥)\s*(\d*\.?\d+(?:[eE][-−+]?\d+)?)")
_RATIO_KINDS = frozenset({"OR", "AOR", "RR", "ARR", "HR", "AHR", "IRR"})
_SPRITE_PM_RE = re.compile(r"(?:(?:mean|M)\s*(?:=|:)?\s*)?(?P<mean>[-−]?\d+(?:\.\d+)?)\s*(?:±|\+/-|\+\-)\s*(?P<sd>\d+(?:\.\d+)?)", re.I)
_SPRITE_EQ_RE = re.compile(r"(?:mean|M)\s*(?:\(\s*SD\s*\))?\s*=\s*(?P<mean>[-−]?\d+(?:\.\d+)?)\s*(?:,\s*SD\s*=\s*|\(\s*SD\s*[:=]?\s*)(?P<sd>\d+(?:\.\d+)?)", re.I)
_SPRITE_PAREN_RE = re.compile(r"(?P<mean>[-−]?\d+\.\d+)\s*\(\s*SD\s*[:=]?\s*(?P<sd>\d+(?:\.\d+)?)\s*\)", re.I)
_BOUNDS_UNIT_GUARD = r"(?!\s*(?:items?|questions?|patients?|subjects?|months?|years?|weeks?|days?|%|mg|kg|cm)\b)"
_SPRITE_BOUNDS_RES = (
    re.compile(rf"\b(?:Likert(?:\s+scale)?|scale|scored?|rated|rating|points?)\s*(?:of|from|:|=|\()?\s*(?P<lo>\d+(?:\.\d+)?)\s*(?:-|–|—|to|~)\s*(?P<hi>\d+(?:\.\d+)?){_BOUNDS_UNIT_GUARD}", re.I),
    re.compile(rf"(?P<lo>\d+(?:\.\d+)?)\s*(?:-|–|—|to|~)\s*(?P<hi>\d+(?:\.\d+)?)\s*(?:[- ]?point\s+)?(?:Likert|scale|score|rating)\b", re.I),
    re.compile(rf"\brange\s*(?:of|from|:|=)?\s*(?P<lo>\d+(?:\.\d+)?)\s*(?:-|–|—|to|~)\s*(?P<hi>\d+(?:\.\d+)?){_BOUNDS_UNIT_GUARD}", re.I),
    re.compile(r"\bmin(?:imum)?\s*(?:=|:)?\s*(?P<lo>\d+(?:\.\d+)?)\s*[,;/]\s*max(?:imum)?\s*(?:=|:)?\s*(?P<hi>\d+(?:\.\d+)?)", re.I),
)
_NON_SD_RE = re.compile(r"\b(?:SE|SEM|S\.E\.M?|standard\s+error|CI|IQR|median)\b", re.I)
_INT_SCALE_CUE_RE = re.compile(r"\b(?:Likert|point\s+scale|scored?)\b", re.I)
_FRAC_RE = re.compile(r"(?<![\d.])(?P<a>\d{1,6})\s*/\s*(?P<n>\d{1,6})(?![\d./])")
_TWO_BY_TWO_VS_RE = re.compile(
    r"(?<![\d.])(?P<a1>\d{1,6})\s*/\s*(?P<n1>\d{1,6})(?:[^.\n]{0,45}?)\b(?:vs\.?|versus|compared\s+(?:with|to))\b"
    r"(?:[^.\n]{0,45}?)(?P<a2>\d{1,6})\s*/\s*(?P<n2>\d{1,6})(?![\d./])",
    re.I,
)
_TWO_BY_TWO_RATIO_RE = re.compile(r"\b(?P<kind>a?OR|a?RR|odds\s+ratio|risk\s+ratio|relative\s+risk)\s*(?:=|:|of)?\s*(?P<est>\d+(?:\.\d+)?)", re.I)
_ADJ_2X2_RE = re.compile(
    r"\b(?:aOR|aRR|adjusted|multivariable|multivariate|logistic\s+regression|cox|propensity|weighted|iptw|"
    r"matched\s+analysis|mantel[- ]?haenszel|stratified|mcnemar|paired|cluster|mixed[- ]?effects?|gee)\b|보정|다변량",
    re.I,
)
_ONE_TAILED_RE = re.compile(r"\b(?:one[- ]?(?:tailed|sided)|단측)\b", re.I)
_COUNT_ROW_CUE_RE = re.compile(r"(?:\bn\s*\(\s*%\s*\)|%|events?|cases?|deaths?|mortality|incidence|responders?|outcomes?|positive|yes|no\.?\s*of)", re.I)
_CONT_ROW_CUE_RE = re.compile(r"\b(?:age|years?|mean|median|sd|iqr|bmi|score|weight|height|bp|mmhg|mg|kg|cm|duration|days|months)\b", re.I)
_KM_HEADER_RE = re.compile(r"(?:number|no\.?|patients?|subjects?)\s+at\s+risk|위험군\s*수", re.I)
_KM_TIME_AXIS_RE = re.compile(r"\b(?:time|months?|years?|weeks?|days?|follow[- ]?up|hours?)\b|개월|시간|주차", re.I)
_KM_STOP_RE = re.compile(r"^\s*(?:Table|Figure|Fig\.?|Results|Discussion|Methods|Introduction|References|Conclusion|Appendix)\b", re.I)
_KM_SKIP_CTX_RE = re.compile(r"(?:left[- ]?truncat|delayed[- ]?entry|time[- ]?varying|지연\s*진입|시간\s*의존)", re.I)
_KM_INT_TOKEN_RE = re.compile(r"^\d{1,6}(?:,\d{3})*$")
_MULT_TEST_RE = re.compile(
    r"(?:"
    r"\b(?:bonferroni|fdr|benjamini|hochberg|holm|tukey|dunnett|fwer)\b"
    r"|\bfalse\s+discovery\s+rate\b"
    r"|\b(?:sidak|šidák|scheffe|scheffé)\b"
    r"|\bgames[- ]howell\b"
    r"|\badjusted\s+p(?:[- ]?values?)?\b"
    r"|\bp[- ]?adjusted\b"
    r"|(?<![a-z0-9])p[_-]?adj(?![a-z0-9])"
    r"|\bq[- ]values?\b"
    r"|\bmultiple[- ]comparisons?\b"
    r"|\bmultiple[- ]testing\b"
    r"|\bfamily[- ]?wise\b"
    r"|다중\s*비교|다중\s*검정|보정(?:된)?\s*p"
    r")",
    re.IGNORECASE,
)


def has_multiple_testing_adjustment(context_text: str) -> bool:
    """Return True if context_text contains an explicit multiple-testing adjustment cue."""
    if not isinstance(context_text, str) or not context_text.strip():
        return False
    return bool(_MULT_TEST_RE.search(context_text))


def _default_store():
    from paper_evidence import default_store
    return default_store


def _norm_text(text):
    return (text or "").replace("−", "-").replace("≤", "<=").replace("≥", ">=")


def _snippet(text, start, end, radius=55):
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    return " ".join(text[lo:hi].split())


def _safe_float(token):
    try:
        return float(str(token).replace("−", "-").replace(",", "").strip())
    except ValueError:
        return None


def _signal(kind, page_index, item_id, excerpt, reported, computed, detail):
    return {
        "kind": kind,
        "pageIndex": page_index,
        "itemId": item_id,
        "excerpt": excerpt,
        "reported": reported,
        "computed": computed,
        "detail": detail,
    }


def _stat_matches(text):
    specs = (
        ("t", _T_PAREN_RE),
        ("t", _T_COMMA_RE),
        ("F", _F_RE),
        ("chi2", _CHI_RE),
        ("z", _Z_RE),
    )
    for kind, pattern in specs:
        for match in pattern.finditer(text):
            yield kind, match


def _sentence_window(norm, start, end, radius=140):
    lo = max(0, start - radius)
    hi = min(len(norm), end + radius)
    left_seg = norm[lo:start]
    left_break = max(left_seg.rfind("\n"), left_seg.rfind(". "), left_seg.rfind("! "), left_seg.rfind("? "))
    if left_break >= 0:
        lo += left_break + 1
    right_seg = norm[end:hi]
    right_breaks = [pos for pos in (right_seg.find("\n"), right_seg.find(". "), right_seg.find("! "), right_seg.find("? ")) if pos >= 0]
    if right_breaks:
        hi = end + min(right_breaks) + 1
    return norm[lo:hi]


def _should_suppress_stat_mismatch(norm, match, res, rep_p, p_dec, header_context):
    local_ctx = _sentence_window(norm, match.start(), match.end(), radius=140)
    window = f"{header_context} {local_ctx}".strip()
    if has_multiple_testing_adjustment(window) and rep_p >= res["computedPRange"][0] - 1e-6:
        return True
    if res["operator"] == "=" and p_dec <= 2 and res["status"] == "inconsistent":
        return abs(rep_p - res["computedP"]) <= 0.01 + 1e-9
    return False


def _scan_stat_pvalues(text, page_index, item_id=None, header_context=""):
    norm = _norm_text(text)
    signals = []
    for kind, match in _stat_matches(norm):
        groups = match.groupdict()
        df1 = _safe_float(groups.get("df1")) if groups.get("df1") else None
        df2 = _safe_float(groups.get("df2")) if groups.get("df2") else None
        val = _safe_float(groups["val"])
        rep_p = _safe_float(groups["p"])
        if val is None or rep_p is None or not 0.0 <= rep_p <= 1.0:
            continue
        p_dec = count_decimals(groups["p"])
        try:
            res = check_stat_pvalue(
                kind, groups["val"], df1, df2, groups["op"], groups["p"], p_dec,
                stat_decimals=count_decimals(groups["val"]),
            )
        except ValueError:
            continue
        if res["status"] != "consistent":
            if _should_suppress_stat_mismatch(norm, match, res, rep_p, p_dec, header_context):
                continue
            detail = f"{kind} reported p {groups['op']} {groups['p']} is {res['status']} (computed p={res['computedP']:.4g})"
            if res["oneTailedCompatible"]:
                detail += "; compatible with one-tailed p"
            signals.append(_signal(
                "stat_pvalue_mismatch", page_index, item_id,
                _snippet(norm, match.start(), match.end()),
                {"statKind": kind, "statValue": res["statValue"], "df1": df1, "df2": df2,
                 "operator": res["operator"], "p": res["reportedP"], "status": res["status"]},
                {"p": round(res["computedP"], 6), "pRange": [round(v, 6) for v in res["computedPRange"]],
                 "oneTailedP": round(res["oneTailedP"], 6) if res["oneTailedP"] is not None else None,
                 "oneTailedCompatible": res["oneTailedCompatible"]},
                detail,
            ))
    return signals


def _scan_count_percentages(text, page_index, item_id=None):
    norm = _norm_text(text)
    signals = []
    for match in _PCT_RE.finditer(norm):
        count, total = int(match.group("count")), int(match.group("total"))
        if total < 2 or count > total:
            continue
        pct_str = match.group("pct")
        res = check_count_percentage(count, total, float(pct_str), count_decimals(pct_str))
        if res["clearMismatch"]:
            signals.append(_signal(
                "percentage_mismatch", page_index, item_id,
                _snippet(norm, match.start(), match.end()),
                {"count": count, "total": total, "pct": res["reportedPct"]},
                {"pct": round(res["computedPct"], 4), "diffPctPoints": round(res["diffPctPoints"], 4)},
                f"{count}/{total} computes to {res['computedPct']:.2f}%, reported {pct_str}%",
            ))
    return signals


def _scan_grim(text, page_index, item_id=None):
    norm = _norm_text(text)
    signals = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", norm):
        if not sentence.strip() or _CONT_UNIT_RE.search(sentence):
            continue
        m_mean = _MEAN_RE.search(sentence)
        m_n = _N_EQ_RE.search(sentence)
        if not m_mean or not m_n:
            continue
        n_val = int(m_n.group("n"))
        if n_val < 1:
            continue
        m_items = _ITEM_COUNT_RE.search(sentence)
        items = int(m_items.group("items")) if m_items else 1
        try:
            res = check_grim(m_mean.group("mean"), n_val, items=items)
        except ValueError:
            continue
        if res["applicable"] and not res["consistent"]:
            signals.append(_signal(
                "grim_impossible", page_index, item_id,
                sentence.strip()[:160],
                {"mean": res["meanStr"], "n": n_val, "items": items},
                {"closestInteger": res["closestInteger"], "closestValue": res["closestValue"]},
                f"GRIM: mean {res['meanStr']} is not achievable with N={n_val}, items={items}",
            ))
    return signals


def _scan_ci_expressions(text, page_index, item_id=None):
    norm = _norm_text(text)
    signals = []
    for match in _CI_EXPR_RE.finditer(norm):
        kind = match.group("kind")
        has_ratio_kind = bool(kind and kind.upper() in _RATIO_KINDS)
        if not match.group("tag") and not has_ratio_kind:
            continue
        est_s, lo_s, hi_s = match.group("est"), match.group("lo"), match.group("hi")
        try:
            res = check_ci_bounds(est_s, lo_s, hi_s, measure_kind=kind)
        except ValueError:
            continue
        if not res["consistent"]:
            signals.append(_signal(
                "ci_containment_or_symmetry", page_index, item_id,
                _snippet(norm, match.start(), match.end()),
                {"measureKind": kind, "estimate": res["estimate"], "lower": res["lower"], "upper": res["upper"]},
                {"issues": res["issues"], "geomMid": round(res["geomMid"], 4) if res["geomMid"] else None,
                 "logAsymmetry": round(res["logAsymmetry"], 4) if res["logAsymmetry"] is not None else None},
                f"CI check flagged {', '.join(res['issues'])} for {est_s} ({lo_s} to {hi_s})",
            ))
    return signals


def _extract_scale_bounds(text):
    for pat in _SPRITE_BOUNDS_RES:
        m = pat.search(text)
        if m:
            lo, hi = _safe_float(m.group("lo")), _safe_float(m.group("hi"))
            if lo is not None and hi is not None and lo < hi:
                return lo, hi
    return None, None


def _sprite_matches(norm):
    found = []
    for pat in (_SPRITE_EQ_RE, _SPRITE_PAREN_RE, _SPRITE_PM_RE):
        for m in pat.finditer(norm):
            if _NON_SD_RE.search(norm[max(0, m.start() - 20):min(len(norm), m.end() + 20)]):
                continue
            if pat is _SPRITE_PM_RE and "." not in m.group("mean") and "." not in m.group("sd") and not re.search(r"\b(?:mean|M|SD)\b", norm[max(0, m.start() - 18):m.start()], re.I):
                continue
            found.append(m)
    return found


def _nearest_n(n_matches, pos):
    if not n_matches:
        return None
    best = min(n_matches, key=lambda m: min(abs(m.start() - pos), abs(m.end() - pos)))
    val = int(best.group("n"))
    return val if val >= 2 else None


def _eval_sprite_candidate(mean_s, sd_s, n_val, lo, hi, integer_scale, page_index, item_id, excerpt):
    try:
        res = check_sprite(
            mean_s, sd_s, n_val, lo, hi,
            mean_decimals=count_decimals(mean_s),
            sd_decimals=count_decimals(sd_s),
            integer_scale=integer_scale,
        )
    except ValueError:
        return None
    if res["consistent"]:
        return None
    return _signal(
        "sprite_bounds_mismatch", page_index, item_id, excerpt,
        {"mean": res["mean"], "sd": res["sd"], "n": n_val, "bounds": [lo, hi]},
        {"reason": res["reason"], "sdBounds": res["sdBounds"]},
        f"SPRITE: mean={mean_s}, SD={sd_s} (n={n_val}) infeasible on [{lo:g}, {hi:g}] ({res['reason']})",
    )


def _scan_sprite(text, page_index, item_id=None, header_context="", default_n=None):
    norm = _norm_text(text)
    signals = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", norm):
        s_clean = sentence.strip()
        if not s_clean:
            continue
        ctx = f"{header_context} {s_clean}".strip()
        lo, hi = _extract_scale_bounds(ctx)
        if lo is None:
            continue
        n_matches = list(_N_EQ_RE.finditer(s_clean))
        is_int = bool(_INT_SCALE_CUE_RE.search(ctx)) or not bool(_CONT_UNIT_RE.search(ctx))
        for m in _sprite_matches(s_clean):
            n_val = _nearest_n(n_matches, m.start()) or default_n
            if not n_val or n_val < 2:
                continue
            sig = _eval_sprite_candidate(
                m.group("mean"), m.group("sd"), n_val, lo, hi, is_int, page_index, item_id, s_clean[:180],
            )
            if sig:
                signals.append(sig)
    return signals


def _extract_2x2_pair(sentence):
    m_vs = _TWO_BY_TWO_VS_RE.search(sentence)
    if m_vs:
        a1, n1 = int(m_vs.group("a1")), int(m_vs.group("n1"))
        a2, n2 = int(m_vs.group("a2")), int(m_vs.group("n2"))
        if n1 >= 2 and n2 >= 2 and 0 <= a1 <= n1 and 0 <= a2 <= n2:
            return (a1, n1, a2, n2, m_vs.start(), m_vs.end())
    fracs = []
    for m in _FRAC_RE.finditer(sentence):
        a, n = int(m.group("a")), int(m.group("n"))
        if n >= 2 and 0 <= a <= n:
            fracs.append((a, n, m.start(), m.end()))
    if len(fracs) == 2:
        return (fracs[0][0], fracs[0][1], fracs[1][0], fracs[1][1], fracs[0][2], fracs[1][3])
    return None


def _extract_2x2_claims(sentence, window):
    is_adj = bool(_ADJ_2X2_RE.search(window))
    m_rat = _TWO_BY_TWO_RATIO_RE.search(sentence)
    rep_kind, rep_est, est_dec = None, None, 2
    if m_rat and not is_adj:
        rep_kind = m_rat.group("kind")
        rep_est = m_rat.group("est")
        est_dec = count_decimals(rep_est)
    m_p = _INLINE_P_RE.search(sentence)
    rep_p, p_op, p_dec = None, "=", 3
    if m_p and not is_adj:
        p_op, rep_p = m_p.group(1), m_p.group(2)
        p_dec = count_decimals(rep_p)
    return rep_kind, rep_est, est_dec, rep_p, p_op, p_dec


def _check_2x2_with_exemptions(a1, n1, a2, n2, claims, window, page_index, item_id, excerpt):
    rep_kind, rep_est, est_dec, rep_p, p_op, p_dec = claims
    if rep_est is None and rep_p is None:
        return None
    one_tailed = bool(_ONE_TAILED_RE.search(window))
    try:
        res = check_two_by_two(
            a1, n1, a2, n2,
            reported_kind=rep_kind, reported_est=rep_est, est_decimals=est_dec,
            reported_p=rep_p, p_op=p_op, p_decimals=p_dec, one_tailed=one_tailed,
        )
    except ValueError:
        return None
    if res["consistent"]:
        return None
    if res["issues"] == ["p_mismatch"] and has_multiple_testing_adjustment(window) and rep_p is not None:
        cands = [p for p in (res["fisherP"], res["pearsonP"], res["yatesP"]) if p is not None]
        rep_p_f = _safe_float(rep_p)
        if rep_p_f is not None and cands and rep_p_f >= min(cands) - 1e-6:
            return None
    return _signal(
        "two_by_two_mismatch", page_index, item_id, excerpt,
        {"a1": a1, "n1": n1, "a2": a2, "n2": n2, "kind": rep_kind, "est": rep_est, "p": rep_p, "pOp": p_op},
        {"or": round(res["or"], 4), "rr": round(res["rr"], 4),
         "fisherP": round(res["fisherP"], 6) if res["fisherP"] is not None else None,
         "pearsonP": round(res["pearsonP"], 6), "issues": res["issues"]},
        f"2x2 ({a1}/{n1} vs {a2}/{n2}): {', '.join(res['issues'])} (crude OR={res['or']:.2f}, Fisher p={res['fisherP']:.4g})"
        if res["fisherP"] is not None else f"2x2 ({a1}/{n1} vs {a2}/{n2}): {', '.join(res['issues'])}",
    )


def _scan_two_by_two(text, page_index, item_id=None, header_context=""):
    norm = _norm_text(text)
    signals = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", norm):
        s_clean = sentence.strip()
        if not s_clean:
            continue
        pair = _extract_2x2_pair(s_clean)
        if not pair:
            continue
        a1, n1, a2, n2, _st, _en = pair
        window = f"{header_context} {s_clean}".strip()
        claims = _extract_2x2_claims(s_clean, window)
        sig = _check_2x2_with_exemptions(a1, n1, a2, n2, claims, window, page_index, item_id, s_clean[:180])
        if sig:
            signals.append(sig)
    return signals


def _parse_km_line(line):
    cleaned = re.sub(r"^(?:number|no\.?|patients?|subjects?)\s+at\s+risk\s*[:\-]?\s*|위험군\s*수\s*[:\-]?\s*", "", line.strip(), flags=re.I)
    if not cleaned:
        return None
    tokens = [t.rstrip(",;") for t in cleaned.replace("|", " ").replace("\t", " ").split() if t.rstrip(",;")]
    nums = []
    idx = len(tokens) - 1
    while idx >= 0 and _KM_INT_TOKEN_RE.match(tokens[idx]):
        nums.append(int(tokens[idx].replace(",", "")))
        idx -= 1
    if len(nums) < 2:
        return None
    nums.reverse()
    label = " ".join(tokens[:idx + 1]).strip(" :;-") or "Arm"
    if _KM_TIME_AXIS_RE.search(label) or nums[0] < 2:
        return None
    return label, nums


def _collect_km_blocks(norm):
    lines = norm.splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        if _KM_HEADER_RE.search(lines[i]):
            ctx = " ".join(lines[max(0, i - 3):min(len(lines), i + 12)])
            rows = []
            inline = _parse_km_line(lines[i])
            if inline:
                rows.append((inline[0], inline[1], lines[i].strip()))
            for j in range(i + 1, min(len(lines), i + 10)):
                ln = lines[j].strip()
                if not ln:
                    if rows:
                        break
                    continue
                if _KM_STOP_RE.match(ln):
                    break
                parsed = _parse_km_line(ln)
                if parsed:
                    rows.append((parsed[0], parsed[1], ln))
            if rows:
                blocks.append((rows, ctx))
        i += 1
    return blocks


def _scan_km_at_risk(text, page_index, item_id=None):
    norm = _norm_text(text)
    signals = []
    for rows, ctx in _collect_km_blocks(norm):
        series = [{"arm": arm, "counts": nums} for arm, nums, _ln in rows]
        res = check_km_at_risk(series, context_text=ctx)
        if res["consistent"]:
            continue
        for v in res["violations"]:
            excerpt = next((ln for arm, _n, ln in rows if arm == v["arm"]), v["arm"])
            signals.append(_signal(
                "km_at_risk_non_monotonic", page_index, item_id, excerpt[:180],
                {"arm": v["arm"], "prev": v["prev"], "value": v["value"], "index": v["index"]},
                v,
                f"KM No. at risk ({v['arm']}) increased from {v['prev']} to {v['value']} at timepoint {v['index'] + 1}",
            ))
    return signals


def _table_grid(item):
    table = item.get("table")
    cells = table.get("cells") if isinstance(table, dict) else None
    if not isinstance(cells, list) or not cells:
        return {}, 0, 0, set()
    grid, max_r, max_c, header_rows = {}, 0, 0, set()
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        r, c = cell.get("row"), cell.get("column")
        if type(r) is not int or type(c) is not int or r < 0 or c < 0:
            continue
        grid[(r, c)] = str(cell.get("text") or "")
        max_r, max_c = max(max_r, r + 1), max(max_c, c + 1)
        if cell.get("header") is True:
            header_rows.add(r)
    if not header_rows and max_r > 1:
        header_rows.add(0)
    return grid, max_r, max_c, header_rows


def _parse_plain_number(text):
    cleaned = _norm_text(text).strip()
    if not _PLAIN_NUM_RE.fullmatch(cleaned):
        return None, 0
    raw = cleaned.replace(",", "")
    val = _safe_float(raw)
    return val, count_decimals(raw)


def _column_totals(grid, max_r, max_c, header_rows):
    col_n = {}
    for c in range(max_c):
        for r in sorted(header_rows):
            m = _N_HEADER_RE.search(_norm_text(grid.get((r, c), "")))
            if m:
                col_n[c] = int(m.group(1))
        for r in range(max_r):
            if r in header_rows:
                continue
            row_label = grid.get((r, 0), "").strip()
            if _TOTAL_LABEL_RE.match(row_label):
                val, dec = _parse_plain_number(grid.get((r, c), ""))
                if val is not None and dec == 0 and val > 0 and c not in col_n:
                    col_n[c] = int(val)
    return col_n


def _check_table_percentages(grid, max_r, max_c, header_rows, col_n, page_index, item_id):
    signals = []
    for r in range(max_r):
        if r in header_rows:
            continue
        for c, total in col_n.items():
            if total < 2:
                continue
            cell_txt = _norm_text(grid.get((r, c), ""))
            m = _CELL_PCT_RE.match(cell_txt)
            if not m:
                continue
            has_pct_cue = "%" in cell_txt or any("%" in grid.get((hr, c), "") for hr in header_rows) or "%" in grid.get((r, 0), "")
            if not has_pct_cue:
                continue
            count = int(m.group("count"))
            if count > total:
                continue
            pct_s = m.group("pct")
            res = check_count_percentage(count, total, float(pct_s), count_decimals(pct_s))
            if res["clearMismatch"]:
                signals.append(_signal(
                    "percentage_mismatch", page_index, item_id,
                    cell_txt.strip(),
                    {"count": count, "total": total, "pct": res["reportedPct"], "row": r, "column": c},
                    {"pct": round(res["computedPct"], 4), "diffPctPoints": round(res["diffPctPoints"], 4)},
                    f"Table cell {count}/{total} computes to {res['computedPct']:.2f}%, reported {pct_s}%",
                ))
    return signals


def _summand_check(values_and_decs, total_text, page_index, item_id, label, axis):
    total_val, total_dec = _parse_plain_number(total_text)
    if total_val is None or len(values_and_decs) < 2:
        return None
    if any(v is None for v, _d in values_and_decs):
        return None
    decs = {d for _v, d in values_and_decs} | {total_dec}
    if len(decs) > 1 and 0 in decs:
        return None
    max_dec = max(decs)
    computed = sum(v for v, _d in values_and_decs)
    tol = 0.0 if max_dec == 0 else 0.5 * (len(values_and_decs) + 1) * (10.0 ** (-max_dec)) + 1e-9
    if abs(computed - total_val) <= tol:
        return None
    return _signal(
        "table_sum_mismatch", page_index, item_id,
        f"{label}: total={total_text.strip()} vs sum={computed:.{max_dec}f}",
        {"axis": axis, "label": label, "total": total_val},
        {"sum": round(computed, max_dec), "summandCount": len(values_and_decs)},
        f"Table {axis} '{label}' reports {total_text.strip()}, summands sum to {computed:.{max_dec}f}",
    )


def _check_table_row_sums(grid, max_r, max_c, header_rows, page_index, item_id):
    signals = []
    start_r = 0
    for r in range(max_r):
        if r in header_rows:
            start_r = r + 1
            continue
        label = grid.get((r, 0), "").strip()
        if _TOTAL_LABEL_RE.match(label) and "subtotal" not in label.lower():
            for c in range(1, max_c):
                vals = [_parse_plain_number(grid.get((rr, c), "")) for rr in range(start_r, r) if rr not in header_rows]
                sig = _summand_check(vals, grid.get((r, c), ""), page_index, item_id, label, "column")
                if sig:
                    signals.append(sig)
            start_r = r + 1
    return signals


def _check_table_col_sums(grid, max_r, max_c, header_rows, page_index, item_id):
    signals = []
    total_cols = [c for c in range(1, max_c) if any(_TOTAL_LABEL_RE.match(grid.get((hr, c), "").strip()) for hr in header_rows)]
    for tc in total_cols:
        if tc < 3:
            continue
        for r in range(max_r):
            if r in header_rows:
                continue
            label = grid.get((r, 0), "").strip() or f"row-{r}"
            vals = [_parse_plain_number(grid.get((r, cc), "")) for cc in range(1, tc)]
            sig = _summand_check(vals, grid.get((r, tc), ""), page_index, item_id, label, "row")
            if sig:
                signals.append(sig)
    return signals


_CELL_PM_RE = re.compile(r"^\s*(?P<mean>[-−]?\d+(?:\.\d+)?)\s*(?:±|\+/-|\+\-)\s*(?P<sd>\d+(?:\.\d+)?)\s*$")
_CELL_PAREN_SD_RE = re.compile(r"^\s*(?P<mean>[-−]?\d+(?:\.\d+)?)\s*\(\s*(?:SD\s*[:=]?\s*)?(?P<sd>\d+(?:\.\d+)?)\s*\)\s*$", re.I)
_CELL_FRAC_ONLY_RE = re.compile(r"^\s*(?P<a>\d{1,6})\s*/\s*(?P<n>\d{1,6})(?:\s*\([^)]*\))?\s*$")
_P_CELL_RE = re.compile(r"^\s*(?:[pP]\s*)?(?P<op>=|<|<=|>|>=|≤|≥)?\s*(?P<p>\d*\.?\d+(?:[eE][-−+]?\d+)?)\s*$")
_EST_CELL_RE = re.compile(r"^\s*(?P<est>\d+(?:\.\d+)?)")


def _check_table_sprite_cell(text, header_ctx, n_val, page_index, item_id):
    norm = _norm_text(text).strip()
    lo, hi = _extract_scale_bounds(header_ctx)
    if lo is None or _NON_SD_RE.search(header_ctx):
        return None
    m = _CELL_PM_RE.match(norm)
    if not m and "SD" in header_ctx.upper():
        m = _CELL_PAREN_SD_RE.match(norm)
    if not m:
        return None
    is_int = bool(_INT_SCALE_CUE_RE.search(header_ctx)) or not bool(_CONT_UNIT_RE.search(header_ctx))
    return _eval_sprite_candidate(
        m.group("mean"), m.group("sd"), n_val, lo, hi, is_int, page_index, item_id, f"{header_ctx}: {norm}"[:180],
    )


def _col_header(grid, header_rows, c):
    return " ".join(grid.get((hr, c), "") for hr in sorted(header_rows)).strip()


def _extract_cell_event_count(txt, total, row_ctx, col_ctx):
    norm = _norm_text(txt).strip()
    m_pct = _CELL_PCT_RE.match(norm)
    if m_pct:
        cnt = int(m_pct.group("count"))
        return (cnt, True) if cnt <= total else (None, False)
    m_frac = _CELL_FRAC_ONLY_RE.match(norm)
    if m_frac:
        cnt, denom = int(m_frac.group("a")), int(m_frac.group("n"))
        return (cnt, True) if denom == total and cnt <= total else (None, False)
    val, dec = _parse_plain_number(norm)
    if val is not None and dec == 0 and 0 <= val <= total:
        cue_txt = f"{row_ctx} {col_ctx}"
        if _COUNT_ROW_CUE_RE.search(cue_txt) and not _CONT_ROW_CUE_RE.search(cue_txt):
            return int(val), False
    return None, False


def _find_2x2_table_cols(grid, max_c, header_rows, col_n):
    arms = [c for c in sorted(col_n) if col_n[c] >= 2 and not _TOTAL_LABEL_RE.match(_col_header(grid, header_rows, c))]
    if len(arms) != 2:
        return None
    p_col, ratio_col, ratio_kind = None, None, None
    for c in range(max_c):
        if c in arms:
            continue
        hdr = _col_header(grid, header_rows, c)
        if p_col is None and re.search(r"\bp(?:[- ]?value)?\b", hdr, re.I) and not has_multiple_testing_adjustment(hdr):
            p_col = c
        elif ratio_col is None:
            m_k = re.search(r"\b(a?OR|a?RR)\b", hdr, re.I)
            if m_k and not _ADJ_2X2_RE.search(hdr):
                ratio_col, ratio_kind = c, m_k.group(1)
    return arms[0], arms[1], p_col, ratio_col, ratio_kind


def _parse_p_cell(text):
    m = _P_CELL_RE.match(_norm_text(text))
    if not m:
        return None, "=", 3
    p_str = m.group("p")
    val = _safe_float(p_str)
    if val is None or not 0.0 <= val <= 1.0:
        return None, "=", 3
    return p_str, (m.group("op") or "="), count_decimals(p_str)


def _audit_table_2x2_row(grid, r, c1, c2, p_col, ratio_col, ratio_kind, header_rows, col_n, ctx_base, page_index, item_id):
    row_lbl = grid.get((r, 0), "").strip()
    if _TOTAL_LABEL_RE.match(row_lbl) or _CONT_ROW_CUE_RE.search(row_lbl) or _ADJ_2X2_RE.search(row_lbl):
        return None
    n1, n2 = col_n[c1], col_n[c2]
    a1, exp1 = _extract_cell_event_count(grid.get((r, c1), ""), n1, row_lbl, _col_header(grid, header_rows, c1))
    a2, exp2 = _extract_cell_event_count(grid.get((r, c2), ""), n2, row_lbl, _col_header(grid, header_rows, c2))
    if a1 is None or a2 is None or not (exp1 or exp2 or _COUNT_ROW_CUE_RE.search(row_lbl)):
        return None
    rep_p, p_op, p_dec = _parse_p_cell(grid.get((r, p_col), "")) if p_col is not None else (None, "=", 3)
    rep_est, est_dec = None, 2
    if ratio_col is not None:
        m_e = _EST_CELL_RE.match(_norm_text(grid.get((r, ratio_col), "")))
        if m_e:
            rep_est, est_dec = m_e.group("est"), count_decimals(m_e.group("est"))
    claims = (ratio_kind if rep_est else None, rep_est, est_dec, rep_p, p_op, p_dec)
    excerpt = f"{row_lbl}: {a1}/{n1} vs {a2}/{n2}"
    return _check_2x2_with_exemptions(a1, n1, a2, n2, claims, f"{ctx_base} {row_lbl}", page_index, item_id, excerpt[:180])


def _check_table_two_by_two(grid, max_r, max_c, header_rows, col_n, caption, page_index, item_id):
    cols = _find_2x2_table_cols(grid, max_c, header_rows, col_n)
    if not cols:
        return []
    c1, c2, p_col, ratio_col, ratio_kind = cols
    if p_col is None and ratio_col is None:
        return []
    all_hdr = " ".join(_col_header(grid, header_rows, c) for c in range(max_c))
    ctx_base = f"{caption} {all_hdr}"
    if _ADJ_2X2_RE.search(ctx_base):
        return []
    signals = []
    for r in range(max_r):
        if r in header_rows:
            continue
        sig = _audit_table_2x2_row(grid, r, c1, c2, p_col, ratio_col, ratio_kind, header_rows, col_n, ctx_base, page_index, item_id)
        if sig:
            signals.append(sig)
    return signals


def _km_table_row_counts(grid, r, max_c):
    nums = []
    for c in range(1, max_c):
        cell = _norm_text(grid.get((r, c), "")).strip()
        if not cell:
            continue
        if not _KM_INT_TOKEN_RE.match(cell):
            return None
        nums.append(int(cell.replace(",", "")))
    return nums if len(nums) >= 2 and nums[0] >= 2 else None


def _check_table_km_at_risk(grid, max_r, max_c, header_rows, caption, page_index, item_id):
    all_text = f"{caption} " + " ".join(grid.values())
    if not _KM_HEADER_RE.search(all_text):
        return []
    rows = []
    for r in range(max_r):
        if r in header_rows:
            continue
        lbl = grid.get((r, 0), "").strip() or f"Row {r}"
        if _KM_TIME_AXIS_RE.search(lbl) or _KM_HEADER_RE.search(lbl):
            continue
        nums = _km_table_row_counts(grid, r, max_c)
        if nums:
            rows.append({"arm": lbl, "counts": nums})
    res = check_km_at_risk(rows, context_text=all_text) if rows else {"consistent": True}
    if res["consistent"]:
        return []
    return [
        _signal(
            "km_at_risk_non_monotonic", page_index, item_id,
            f"{v['arm']}: {v['prev']} -> {v['value']}"[:180],
            {"arm": v["arm"], "prev": v["prev"], "value": v["value"], "index": v["index"]},
            v,
            f"KM table No. at risk ({v['arm']}) increased from {v['prev']} to {v['value']} at timepoint {v['index'] + 1}",
        )
        for v in res["violations"]
    ]


def _audit_table_item(item, page_index, item_id):
    grid, max_r, max_c, header_rows = _table_grid(item)
    if not grid:
        return []
    caption = str(item.get("caption") or "")
    col_n = _column_totals(grid, max_r, max_c, header_rows)
    signals = _check_table_percentages(grid, max_r, max_c, header_rows, col_n, page_index, item_id)
    signals.extend(_check_table_row_sums(grid, max_r, max_c, header_rows, page_index, item_id))
    signals.extend(_check_table_col_sums(grid, max_r, max_c, header_rows, page_index, item_id))
    signals.extend(_check_table_two_by_two(grid, max_r, max_c, header_rows, col_n, caption, page_index, item_id))
    signals.extend(_check_table_km_at_risk(grid, max_r, max_c, header_rows, caption, page_index, item_id))
    for (r, c), text in grid.items():
        if r in header_rows or not text.strip():
            continue
        col_hdr = " ".join(grid.get((hr, c), "") for hr in header_rows)
        row_hdr = grid.get((r, 0), "")
        header_context = f"{caption} {col_hdr} {row_hdr}".strip()
        context_text = f"{header_context} {text}"
        signals.extend(_scan_stat_pvalues(text, page_index, item_id=item_id, header_context=header_context))
        signals.extend(_scan_ci_expressions(context_text if "CI" in context_text.upper() else text, page_index, item_id=item_id))
        signals.extend(_scan_two_by_two(text, page_index, item_id=item_id, header_context=header_context))
        signals.extend(_scan_sprite(text, page_index, item_id=item_id, header_context=header_context, default_n=col_n.get(c)))
        if c in col_n:
            sprite_sig = _check_table_sprite_cell(text, header_context, col_n[c], page_index, item_id)
            if sprite_sig:
                signals.append(sprite_sig)
    return signals


def _table_cell_facts(norm, hdr, pcts, pvals, cis):
    for m in _INLINE_PCT_RE.finditer(norm):
        pcts.append((float(m.group(1)), count_decimals(m.group(1))))
    if "%" in hdr:
        m_pct = _CELL_PCT_RE.match(norm)
        if m_pct:
            pcts.append((float(m_pct.group("pct")), count_decimals(m_pct.group("pct"))))
    for m in _INLINE_P_RE.finditer(norm):
        val = _safe_float(m.group(2))
        if val is not None:
            pvals.append((val, count_decimals(m.group(2))))
    if re.search(r"\bp(?:[- ]?value)?\b", hdr):
        val, dec = _parse_plain_number(norm)
        if val is not None and 0.0 <= val <= 1.0:
            pvals.append((val, dec))
    for m in _CI_EXPR_RE.finditer(norm):
        est, lo, hi = _safe_float(m.group("est")), _safe_float(m.group("lo")), _safe_float(m.group("hi"))
        if est is not None and lo is not None and hi is not None:
            cis.append((est, lo, hi))


def _table_facts(item):
    grid, _max_r, _max_c, header_rows = _table_grid(item)
    pcts, pvals, cis = [], [], []
    for (r, c), txt in grid.items():
        if r in header_rows:
            continue
        hdr = " ".join(grid.get((hr, c), "") for hr in header_rows).lower()
        _table_cell_facts(_norm_text(txt), hdr, pcts, pvals, cis)
    return {"pcts": pcts, "pvals": pvals, "cis": cis}


def _extract_ci_list(raw_bounds, cis, pts):
    entries = raw_bounds if isinstance(raw_bounds, list) else ([raw_bounds] if isinstance(raw_bounds, dict) else [])
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        lo = _safe_float(entry.get("lower") if "lower" in entry else entry.get("lowerCi"))
        hi = _safe_float(entry.get("upper") if "upper" in entry else entry.get("upperCi"))
        val = _safe_float(entry.get("value"))
        if val is not None:
            pts.append(val)
        if lo is not None and hi is not None:
            cis.append((val if val is not None else 0.5 * (lo + hi), lo, hi))


def _extract_series_cis(geom, cis, pts):
    if not isinstance(geom, dict):
        return
    for series in geom.get("series") or []:
        if not isinstance(series, dict):
            continue
        for pt in series.get("points") or []:
            if not isinstance(pt, dict) or not isinstance(pt.get("ciBounds"), dict):
                continue
            cb = pt["ciBounds"]
            lo, hi, val = _safe_float(cb.get("lower")), _safe_float(cb.get("upper")), _safe_float(pt.get("y"))
            if lo is not None and hi is not None:
                cis.append((val if val is not None else 0.5 * (lo + hi), lo, hi))
                if val is not None:
                    pts.append(val)


def _figure_facts(item):
    pcts, pvals, cis, pts = [], [], [], []
    sources = [item]
    if isinstance(item.get("chart"), dict):
        sources.append(item["chart"])
    for src in sources:
        for pv in src.get("printedValues") or []:
            if not isinstance(pv, dict):
                continue
            val, lo, hi = _safe_float(pv.get("value")), _safe_float(pv.get("lowerCi")), _safe_float(pv.get("upperCi"))
            if val is not None:
                pts.append(val)
            if lo is not None and hi is not None:
                cis.append((val if val is not None else 0.5 * (lo + hi), lo, hi))
            for m in _INLINE_PCT_RE.finditer(str(pv.get("rawText") or "")):
                pcts.append((float(m.group(1)), count_decimals(m.group(1))))
        _extract_ci_list(src.get("ciBounds"), cis, pts)
        _extract_series_cis(src.get("geometry"), cis, pts)
    return {"pcts": pcts, "pvals": pvals, "cis": cis, "pts": pts}


def _collect_artifact_index(items):
    index = {}
    for item in items:
        caption = item.get("caption")
        if not isinstance(caption, str) or not caption.strip():
            continue
        kind = item.get("type")
        m = _REF_TABLE_RE.search(caption) if kind == "table" else _REF_FIG_RE.search(caption)
        if not m:
            continue
        key = (kind, m.group("label").lower())
        facts = _table_facts(item) if kind == "table" else _figure_facts(item)
        entry = index.setdefault(key, {"itemId": item["id"], "pcts": [], "pvals": [], "cis": [], "pts": []})
        for field in ("pcts", "pvals", "cis", "pts"):
            entry[field].extend(facts.get(field, ()))
    return index


def _value_matches(target, dec, pool):
    tol = max(0.15, 0.5 * (10.0 ** (-dec)))
    return any(abs(target - cand) <= max(tol, 0.5 * (10.0 ** (-c_dec))) for cand, c_dec in pool)


def _p_matches(target, dec, pool):
    tol = max(1e-4, 0.5 * (10.0 ** (-dec)))
    return any(abs(target - cand) <= max(tol, 0.5 * (10.0 ** (-c_dec))) for cand, c_dec in pool)


def _ci_matches(est, lo, hi, entry):
    return any(
        abs(est - c_est) <= 0.05 and abs(lo - c_lo) <= 0.05 and abs(hi - c_hi) <= 0.05
        for c_est, c_lo, c_hi in entry["cis"]
    )


def _compare_pcts(sentence, page_index, kind, label, entry):
    signals = []
    for m in _INLINE_PCT_RE.finditer(sentence):
        val, dec = float(m.group(1)), count_decimals(m.group(1))
        if not _value_matches(val, dec, entry["pcts"]):
            signals.append(_signal(
                "cross_modal_number_mismatch", page_index, entry["itemId"], sentence[:180],
                {"target": f"{kind} {label}", "pct": val},
                {"artifactPcts": sorted({round(v, 4) for v, _ in entry["pcts"]})[:10]},
                f"Body text citing {kind.title()} {label} states {val}%, not found in {kind} values",
            ))
    return signals


def _compare_pvals(sentence, page_index, kind, label, entry):
    signals = []
    for m in _INLINE_P_RE.finditer(sentence):
        val = _safe_float(m.group(2))
        if m.group(1) == "=" and val is not None and not _p_matches(val, count_decimals(m.group(2)), entry["pvals"]):
            signals.append(_signal(
                "cross_modal_number_mismatch", page_index, entry["itemId"], sentence[:180],
                {"target": f"{kind} {label}", "p": val},
                {"artifactPValues": sorted({round(v, 6) for v, _ in entry["pvals"]})[:10]},
                f"Body text citing {kind.title()} {label} states p={val}, not found in {kind} p-values",
            ))
    return signals


def _compare_cis(sentence, page_index, kind, label, entry):
    signals = []
    for m in _CI_EXPR_RE.finditer(sentence):
        est, lo, hi = _safe_float(m.group("est")), _safe_float(m.group("lo")), _safe_float(m.group("hi"))
        if est is not None and lo is not None and hi is not None and not _ci_matches(est, lo, hi, entry):
            signals.append(_signal(
                "cross_modal_number_mismatch", page_index, entry["itemId"], sentence[:180],
                {"target": f"{kind} {label}", "estimate": est, "lower": lo, "upper": hi},
                {"artifactCis": entry["cis"][:8]},
                f"Body text citing {kind.title()} {label} states {est} ({lo}-{hi}), differing from {kind} CIs",
            ))
    return signals


def _compare_sentence_to_artifact(sentence, page_index, kind, label, entry):
    signals = _compare_pcts(sentence, page_index, kind, label, entry) if entry["pcts"] else []
    if entry["pvals"]:
        signals.extend(_compare_pvals(sentence, page_index, kind, label, entry))
    if entry["cis"]:
        signals.extend(_compare_cis(sentence, page_index, kind, label, entry))
    return signals


def _scan_cross_modal(page_texts, items):
    index = _collect_artifact_index(items)
    if not index:
        return []
    signals = []
    for page_index, text in page_texts:
        norm = _norm_text(text)
        for raw_sentence in re.split(r"(?<=[.!?])\s+|\n{2,}", norm):
            sentence = " ".join(raw_sentence.split())
            if not sentence or _CAPTION_START_RE.match(sentence):
                continue
            for kind, pat in (("table", _REF_TABLE_RE), ("figure", _REF_FIG_RE)):
                for match in pat.finditer(sentence):
                    entry = index.get((kind, match.group("label").lower()))
                    if entry is not None:
                        signals.extend(_compare_sentence_to_artifact(sentence, page_index, kind, match.group("label"), entry))
    return signals


def _collect_all_items(store, paper_id, file_hash):
    items, offset = [], 0
    for _ in range(10000):
        page = store.list_items(paper_id, kind=None, page_index=None, offset=offset, limit=50)
        batch = page.get("items") or []
        for meta in batch:
            item = store.read_item(paper_id, meta["id"])
            if "fileHash" in item and item.get("fileHash") != file_hash:
                raise ValueError("paper_evidence_hash_mismatch")
            items.append(item)
        nxt = page.get("nextOffset")
        if nxt is None or not batch or type(nxt) is not int or nxt <= offset:
            break
        offset = nxt
    return items


def _read_page_texts(store, paper_id, page_count):
    if not hasattr(store, "source_bytes"):
        return []
    from paper_evidence_text import read_page_text
    texts = []
    for page_index in range(min(page_count, MAX_AUDIT_PAGES)):
        try:
            page = read_page_text(paper_id, page_index, section_only=False, store=store)
        except ValueError as exc:
            if exc.args == ("paper_evidence_source_unavailable",):
                return []
            raise
        texts.append((page_index, page.get("text") or ""))
    return texts


def _dedupe_and_cap(signals, max_signals):
    seen, unique = set(), []
    for sig in signals:
        key = (sig["kind"], sig["pageIndex"], sig["itemId"], sig["excerpt"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    truncated = len(unique) > max_signals
    capped = unique[:max_signals]
    numbered = [{"id": f"stat-{i + 1}", **sig} for i, sig in enumerate(capped)]
    return numbered, truncated


def audit_loaded_paper(paper_id, file_hash, summary, items, *, max_signals=30, store=None):
    """Run deterministic statistical pre-audit given an already-validated summary and loaded items."""
    if isinstance(max_signals, bool) or type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")
    page_texts = _read_page_texts(store, paper_id, summary["pageCount"]) if store is not None else []
    signals = []
    for page_index, text in page_texts:
        signals.extend(_scan_stat_pvalues(text, page_index))
        signals.extend(_scan_count_percentages(text, page_index))
        signals.extend(_scan_grim(text, page_index))
        signals.extend(_scan_ci_expressions(text, page_index))
        signals.extend(_scan_sprite(text, page_index))
        signals.extend(_scan_two_by_two(text, page_index))
        signals.extend(_scan_km_at_risk(text, page_index))
    for item in items:
        if item.get("type") == "table":
            signals.extend(_audit_table_item(item, item.get("pageIndex", 0), item.get("id")))
    signals.extend(_scan_cross_modal(page_texts, items))
    numbered, truncated = _dedupe_and_cap(signals, max_signals)
    return {
        "schema": SCHEMA,
        "paperId": paper_id,
        "fileHash": file_hash,
        "signalCount": len(numbered),
        "truncated": truncated,
        "disclaimer": DISCLAIMER,
        "signals": numbered,
    }


def audit_paper_statistics(paper_id, file_hash=None, *, max_signals=30, store=None):
    """Verify store binding and run deterministic statistical/arithmetic pre-checks."""
    if isinstance(max_signals, bool) or type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")
    store = _default_store() if store is None else store
    try:
        summary = store.status(paper_id)
    except KeyError:
        raise ValueError("paper_evidence_unknown_id") from None
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)
    actual_hash = summary["fileHash"]
    items = _collect_all_items(store, paper_id, actual_hash)
    return audit_loaded_paper(paper_id, actual_hash, summary, items, max_signals=max_signals, store=store)
