"""Pure-Python deterministic statistical distribution and arithmetic check helpers.

Uses only the Python 3.12 standard library (math, decimal) with no scipy or
external dependencies. All functions keep low cyclomatic complexity.
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, ROUND_HALF_UP
import math

_TINY = 1e-300
_RATIO_KINDS = frozenset({"OR", "AOR", "RR", "ARR", "HR", "AHR", "IRR"})
_OPERATORS = frozenset({"=", "<", "<=", ">", ">="})


def _validate_positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0.0:
        raise ValueError(name)
    return float(value)


def _gamma_lower_series(a, x):
    log_pref = -x + a * math.log(x) - math.lgamma(a)
    if log_pref < -745.0:
        return 0.0
    ap = a
    term = 1.0 / a
    total = term
    for _ in range(1, 5000):
        ap += 1.0
        term *= x / ap
        total += term
        if abs(term) <= abs(total) * 1e-15:
            break
    return total * math.exp(log_pref)


def _gamma_upper_cf(a, x):
    log_pref = -x + a * math.log(x) - math.lgamma(a)
    if log_pref < -745.0:
        return 0.0
    b = x + 1.0 - a
    c = 1.0 / _TINY
    d = 1.0 / (b if abs(b) >= _TINY else _TINY)
    h = d
    for i in range(1, 5000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        d = _TINY if abs(d) < _TINY else d
        c = b + an / c
        c = _TINY if abs(c) < _TINY else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) <= 1e-14:
            break
    return h * math.exp(log_pref)


def gammaincc(a, x):
    """Regularized upper incomplete gamma function Q(a, x) for a > 0, x >= 0."""
    a_val = _validate_positive(a, "a")
    if isinstance(x, bool) or not isinstance(x, (int, float)) or math.isnan(x) or x < 0.0:
        raise ValueError("x")
    if math.isinf(x):
        return 0.0
    x_val = float(x)
    if x_val == 0.0:
        return 1.0
    if x_val < a_val + 1.0:
        return max(0.0, min(1.0, 1.0 - _gamma_lower_series(a_val, x_val)))
    return max(0.0, min(1.0, _gamma_upper_cf(a_val, x_val)))


def _cf_step(aa, c, d):
    d = 1.0 + aa * d
    d = _TINY if abs(d) < _TINY else d
    c = 1.0 + aa / c
    c = _TINY if abs(c) < _TINY else c
    d = 1.0 / d
    return c, d, d * c


def _betacf(a, b, x):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    d = 1.0 / (_TINY if abs(d) < _TINY else d)
    h = d
    for m in range(1, 5000):
        m2 = 2 * m
        aa_even = m * (b - m) * x / ((qam + m2) * (a + m2))
        c, d, delta1 = _cf_step(aa_even, c, d)
        h *= delta1
        aa_odd = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        c, d, delta2 = _cf_step(aa_odd, c, d)
        h *= delta2
        if abs(delta2 - 1.0) <= 1e-14:
            break
    return h


def betainc(a, b, x):
    """Regularized incomplete beta function I_x(a, b) for a > 0, b > 0, 0 <= x <= 1."""
    a_val = _validate_positive(a, "a")
    b_val = _validate_positive(b, "b")
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or not 0.0 <= x <= 1.0:
        raise ValueError("x")
    x_val = float(x)
    if x_val == 0.0:
        return 0.0
    if x_val == 1.0:
        return 1.0
    log_bt = math.lgamma(a_val + b_val) - math.lgamma(a_val) - math.lgamma(b_val) + a_val * math.log(x_val) + b_val * math.log1p(-x_val)
    bt = 0.0 if log_bt < -745.0 else math.exp(log_bt)
    if x_val < (a_val + 1.0) / (a_val + b_val + 2.0):
        return max(0.0, min(1.0, bt * _betacf(a_val, b_val, x_val) / a_val))
    return max(0.0, min(1.0, 1.0 - bt * _betacf(b_val, a_val, 1.0 - x_val) / b_val))


def _norm_kind(stat_kind):
    kind = str(stat_kind or "").strip().lower()
    if kind in ("z", "t", "chi2"):
        return kind
    if kind == "f":
        return "F"
    raise ValueError("stat_kind")


def stat_pvalue(stat_kind, stat_value, df1=None, df2=None, *, two_tailed=True):
    """Compute exact two-tailed (or one-tailed for z/t/1-df) p-value for z, t, chi2, F."""
    kind = _norm_kind(stat_kind)
    if isinstance(stat_value, bool) or not isinstance(stat_value, (int, float)) or not math.isfinite(stat_value):
        raise ValueError("stat_value")
    val = float(stat_value)
    if kind == "z":
        p_val = math.erfc(abs(val) / math.sqrt(2.0))
    elif kind == "t":
        d1 = _validate_positive(df1, "df1")
        p_val = betainc(d1 / 2.0, 0.5, d1 / (d1 + val * val))
    elif kind == "chi2":
        d1 = _validate_positive(df1, "df1")
        if val < 0.0:
            raise ValueError("stat_value")
        p_val = gammaincc(d1 / 2.0, val / 2.0)
    else:
        d1, d2 = _validate_positive(df1, "df1"), _validate_positive(df2, "df2")
        if val < 0.0:
            raise ValueError("stat_value")
        p_val = betainc(d2 / 2.0, d1 / 2.0, d2 / (d2 + d1 * val))
    if not two_tailed and (kind in ("z", "t") or df1 == 1):
        return 0.5 * p_val
    return p_val


def count_decimals(token):
    """Return number of decimal places in a numeric string or float."""
    text = str(token).strip().replace("−", "-")
    try:
        dec = Decimal(text)
    except InvalidOperation:
        return 0
    exp = dec.as_tuple().exponent
    return max(0, -exp) if isinstance(exp, int) else 0


def _to_float_and_decimals(value, explicit_decimals=None):
    if isinstance(value, str):
        cleaned = value.strip().replace("−", "-").replace(",", "")
        val = float(cleaned)
        dec = count_decimals(cleaned) if explicit_decimals is None else explicit_decimals
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        val = float(value)
        dec = count_decimals(val) if explicit_decimals is None else explicit_decimals
    else:
        raise ValueError("numeric_value")
    if not math.isfinite(val):
        raise ValueError("numeric_value")
    return val, max(0, int(dec))


def _p_interval_consistent(p_min, p_max, operator, reported_p, p_decimals):
    p_eps = 0.5 * (10.0 ** (-p_decimals))
    slack = 1e-12
    if operator == "=":
        rep_lo = max(0.0, reported_p - p_eps)
        rep_hi = min(1.0, reported_p + p_eps)
        return p_max >= rep_lo - slack and p_min <= rep_hi + slack
    if operator == "<":
        return p_min < reported_p + slack
    if operator == "<=":
        return p_min <= reported_p + slack
    if operator == ">":
        return p_max > reported_p - slack
    return p_max >= reported_p - slack


def _is_decision_inconsistent(p_min, p_max, operator, reported_p, alpha=0.05):
    rep_sig = (operator in ("<", "<=") and reported_p <= alpha) or (operator == "=" and reported_p < alpha)
    rep_nonsig = (operator in (">", ">=") and reported_p >= alpha) or (operator == "=" and reported_p >= alpha)
    if rep_sig and p_min >= alpha:
        return True
    if rep_nonsig and p_max < alpha:
        return True
    return False


def _stat_p_bounds(kind, stat_val, stat_dec, df1, df2):
    s_eps = 0.5 * (10.0 ** (-stat_dec))
    base = abs(stat_val) if kind in ("z", "t") else stat_val
    if kind in ("chi2", "F") and base < 0.0:
        raise ValueError("stat_value")
    s_lo = max(0.0, base - s_eps)
    s_hi = base + s_eps
    p_exact = stat_pvalue(kind, stat_val, df1, df2)
    p_min = stat_pvalue(kind, s_hi, df1, df2)
    p_max = stat_pvalue(kind, s_lo, df1, df2)
    return p_exact, p_min, p_max


def check_stat_pvalue(stat_kind, stat_value, df1, df2, operator, reported_p, decimals, *, stat_decimals=None):
    """Check whether reported test statistic and p-value are consistent within rounding."""
    kind = _norm_kind(stat_kind)
    op = str(operator or "=").strip()
    if op == "==":
        op = "="
    if op not in _OPERATORS:
        raise ValueError("operator")
    if isinstance(decimals, bool) or not isinstance(decimals, int) or decimals < 0:
        raise ValueError("decimals")
    s_val, s_dec = _to_float_and_decimals(stat_value, stat_decimals)
    rep_p, _ = _to_float_and_decimals(reported_p, decimals)
    if not 0.0 <= rep_p <= 1.0:
        raise ValueError("reported_p")
    p_exact, p_min, p_max = _stat_p_bounds(kind, s_val, s_dec, df1, df2)
    consistent = _p_interval_consistent(p_min, p_max, op, rep_p, decimals)
    status = "consistent" if consistent else (
        "decision_inconsistent" if _is_decision_inconsistent(p_min, p_max, op, rep_p) else "inconsistent"
    )
    can_one_tail = kind in ("z", "t") or df1 == 1
    one_tailed_p = 0.5 * p_exact if can_one_tail else None
    one_tailed_ok = bool(
        not consistent and can_one_tail and _p_interval_consistent(0.5 * p_min, 0.5 * p_max, op, rep_p, decimals)
    )
    return {
        "status": status,
        "statKind": kind,
        "statValue": s_val,
        "df1": df1,
        "df2": df2,
        "operator": op,
        "reportedP": rep_p,
        "computedP": p_exact,
        "computedPRange": [p_min, p_max],
        "oneTailedP": one_tailed_p,
        "oneTailedCompatible": one_tailed_ok,
    }


def check_count_percentage(count, total, reported_pct, pct_decimals):
    """Check whether count / total * 100 matches reported_pct within rounding tolerance."""
    if isinstance(total, bool) or not isinstance(total, (int, float)) or total <= 0:
        raise ValueError("total")
    if isinstance(count, bool) or not isinstance(count, (int, float)) or count < 0:
        raise ValueError("count")
    if isinstance(pct_decimals, bool) or not isinstance(pct_decimals, int) or pct_decimals < 0:
        raise ValueError("pct_decimals")
    rep = float(reported_pct)
    if not math.isfinite(rep):
        raise ValueError("reported_pct")
    computed = (float(count) / float(total)) * 100.0
    ulp = 10.0 ** (-pct_decimals)
    diff = abs(computed - rep)
    within_half = diff <= 0.5 * ulp + 1e-12
    clear_mismatch = diff > 0.6 * ulp + 1e-12
    within_one_pp = diff <= 1.0 + 1e-12
    status = "consistent" if not clear_mismatch else ("minor_discrepancy" if within_one_pp else "mismatch")
    return {
        "consistent": not clear_mismatch,
        "status": status,
        "count": count,
        "total": total,
        "reportedPct": rep,
        "computedPct": computed,
        "diffPctPoints": diff,
        "withinHalfUlp": within_half,
        "withinOnePctPoint": within_one_pp,
        "clearMismatch": clear_mismatch,
    }


def _grim_candidates(mean_dec, denom, q_unit):
    center = int((mean_dec * denom).to_integral_value(rounding=ROUND_HALF_UP))
    matched = False
    closest = None
    best_dist = None
    for k in range(center - 2, center + 3):
        exact = Decimal(k) / Decimal(denom)
        r_up = exact.quantize(q_unit, rounding=ROUND_HALF_UP)
        r_even = exact.quantize(q_unit, rounding=ROUND_HALF_EVEN)
        if r_up == mean_dec or r_even == mean_dec:
            matched = True
        dist = abs(exact - mean_dec)
        if best_dist is None or dist < best_dist:
            best_dist = dist
            closest = (k, str(r_up))
    return matched, closest


def check_grim(mean_str, n, items=1):
    """GRIM integer-granularity test for integer-count scale means."""
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("n")
    if isinstance(items, bool) or not isinstance(items, int) or items < 1:
        raise ValueError("items")
    text = str(mean_str).strip().replace("−", "-")
    try:
        mean_dec = Decimal(text)
    except InvalidOperation:
        raise ValueError("mean_str") from None
    decimals = count_decimals(text)
    denom = n * items
    if denom > 10 ** decimals:
        return {
            "applicable": False,
            "consistent": True,
            "meanStr": text,
            "decimals": decimals,
            "n": n,
            "items": items,
            "reason": "N * items exceeds 10^decimals",
        }
    q_unit = Decimal(10) ** (-decimals) if decimals > 0 else Decimal(1)
    matched, closest = _grim_candidates(mean_dec, denom, q_unit)
    return {
        "applicable": True,
        "consistent": matched,
        "meanStr": text,
        "decimals": decimals,
        "n": n,
        "items": items,
        "closestInteger": closest[0] if closest else None,
        "closestValue": closest[1] if closest else None,
    }


def _ci_rounding_slack(est, lo, hi, decimals):
    dec = 2 if decimals is None else max(0, int(decimals))
    eps = 0.5 * (10.0 ** (-dec))
    return 0.5 * (eps / lo + eps / hi) + (eps / est)


def check_ci_bounds(estimate, lower, upper, measure_kind=None, *, decimals=None):
    """Check CI bound ordering, containment, and ratio log-scale symmetry."""
    est, est_dec = _to_float_and_decimals(estimate, decimals)
    lo, lo_dec = _to_float_and_decimals(lower, decimals)
    hi, hi_dec = _to_float_and_decimals(upper, decimals)
    issues = []
    if lo > hi:
        issues.append("inverted_bounds")
    elif est < lo - 1e-12 or est > hi + 1e-12:
        issues.append("point_outside_ci")
    kind_norm = str(measure_kind or "").strip().upper() or None
    geom_mid = None
    log_asym = None
    if kind_norm in _RATIO_KINDS and est > 0.0 and lo > 0.0 and hi > 0.0:
        geom_mid = math.sqrt(lo * hi)
        log_asym = abs(math.log(est) - 0.5 * (math.log(lo) + math.log(hi)))
        used_dec = decimals if decimals is not None else (
            min(est_dec, lo_dec, hi_dec) if any(isinstance(v, str) for v in (estimate, lower, upper)) else 2
        )
        slack = _ci_rounding_slack(est, lo, hi, used_dec)
        if log_asym > 0.25 + slack:
            issues.append("log_asymmetry")
    return {
        "consistent": not issues,
        "issues": issues,
        "measureKind": measure_kind,
        "estimate": est,
        "lower": lo,
        "upper": hi,
        "geomMid": geom_mid,
        "logAsymmetry": log_asym,
    }
