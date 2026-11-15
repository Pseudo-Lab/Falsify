"""Pure-Python deterministic statistical distribution and arithmetic check helpers.

Uses only the Python 3.12 standard library (math, decimal) with no scipy or
external dependencies. All functions keep low cyclomatic complexity.
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, ROUND_HALF_UP
import math
import re

_TINY = 1e-300
_RATIO_KINDS = frozenset({"OR", "AOR", "RR", "ARR", "HR", "AHR", "IRR"})
_OPERATORS = frozenset({"=", "<", "<=", ">", ">="})
_KM_SKIP_RE = re.compile(r"(?:left[- ]?truncat|delayed[- ]?entry|time[- ]?varying|지연\s*진입|시간\s*의존)", re.I)


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


def _validate_nonneg_int_param(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(name)
    return value


def _sprite_validate_inputs(mean, sd, n, min_val, max_val, mean_decimals, sd_decimals):
    if isinstance(n, bool) or not isinstance(n, int) or n < 2:
        raise ValueError("n")
    m_dec = _validate_nonneg_int_param(mean_decimals, "mean_decimals")
    s_dec = _validate_nonneg_int_param(sd_decimals, "sd_decimals")
    mean_v, _ = _to_float_and_decimals(mean, m_dec)
    sd_v, _ = _to_float_and_decimals(sd, s_dec)
    min_f, _ = _to_float_and_decimals(min_val, 0)
    max_f, _ = _to_float_and_decimals(max_val, 0)
    if min_f >= max_f:
        raise ValueError("bounds")
    if sd_v < 0.0:
        raise ValueError("sd")
    return mean_v, sd_v, min_f, max_f, m_dec, s_dec


def _sprite_int_var_min(s_val, n):
    k = s_val % n
    return (k * (n - k)) / (n * (n - 1))


def _sprite_int_var_max(s_val, n, a, b):
    span = b - a
    excess = s_val - n * a
    nb, rem = divmod(excess, span)
    if rem == 0:
        sum_sq = nb * (b * b) + (n - nb) * (a * a)
    else:
        sum_sq = nb * (b * b) + (a + rem) * (a + rem) + (n - nb - 1) * (a * a)
    return max(0.0, (sum_sq - (s_val * s_val) / n) / (n - 1))


def _sprite_int_candidates(n, a, b, s_lo, s_hi):
    if s_hi - s_lo <= 2000:
        return range(s_lo, s_hi + 1)
    s_mid = max(s_lo, min(s_hi, round(0.5 * n * (a + b))))
    radius = min(b - a + 2, 200)
    cands = set(range(s_lo, min(s_hi + 1, s_lo + 100)))
    cands.update(range(max(s_lo, s_hi - 99), s_hi + 1))
    cands.update(range(max(s_lo, s_mid - radius), min(s_hi + 1, s_mid + radius + 1)))
    return cands


def _sprite_int_sd_bounds(n, a, b, s_lo, s_hi):
    if s_hi - s_lo >= n - 1 or (s_lo % n) == 0 or (s_lo // n) != (s_hi // n):
        var_min = 0.0
    else:
        var_min = min(_sprite_int_var_min(s_lo, n), _sprite_int_var_min(s_hi, n))
    var_max = max(_sprite_int_var_max(s, n, a, b) for s in _sprite_int_candidates(n, a, b, s_lo, s_hi))
    return math.sqrt(var_min), math.sqrt(var_max)


def _sprite_cont_sd_bounds(n, min_f, max_f, mu_lo, mu_hi):
    mid = 0.5 * (min_f + max_f)
    mu_star = min(mu_hi, max(mu_lo, mid))
    var_max = (n / (n - 1)) * (max_f - mu_star) * (mu_star - min_f)
    return 0.0, math.sqrt(max(0.0, var_max))


def _sprite_result(consistent, reason, mean_v, sd_v, n, min_f, max_f, use_int, sd_bounds, rep_sd_range):
    return {
        "consistent": consistent,
        "reason": reason,
        "mean": mean_v,
        "sd": sd_v,
        "n": n,
        "minVal": min_f,
        "maxVal": max_f,
        "integerScale": use_int,
        "sdBounds": sd_bounds,
        "reportedSdRange": rep_sd_range,
    }


def check_sprite(mean, sd, n, min_val, max_val, *, mean_decimals=2, sd_decimals=2, integer_scale=True):
    """Check SPRITE mathematical feasibility of (mean, SD, N) on bounded scale [min_val, max_val]."""
    mean_v, sd_v, min_f, max_f, m_dec, s_dec = _sprite_validate_inputs(
        mean, sd, n, min_val, max_val, mean_decimals, sd_decimals
    )
    mean_eps = 0.5 * (10.0 ** (-m_dec))
    sd_eps = 0.5 * (10.0 ** (-s_dec))
    rep_mu_lo, rep_mu_hi = mean_v - mean_eps, mean_v + mean_eps
    rep_sd_range = [max(0.0, sd_v - sd_eps), sd_v + sd_eps]
    use_int = bool(integer_scale) and min_f.is_integer() and max_f.is_integer()
    if rep_mu_hi < min_f - 1e-12 or rep_mu_lo > max_f + 1e-12:
        return _sprite_result(False, "mean_out_of_bounds", mean_v, sd_v, n, min_f, max_f, use_int, [None, None], rep_sd_range)
    mu_lo, mu_hi = max(min_f, rep_mu_lo), min(max_f, rep_mu_hi)
    if use_int:
        a, b = int(min_f), int(max_f)
        s_lo = max(n * a, math.ceil(n * mu_lo - 1e-12))
        s_hi = min(n * b, math.floor(n * mu_hi + 1e-12))
        if s_lo > s_hi:
            return _sprite_result(False, "grim_infeasible", mean_v, sd_v, n, min_f, max_f, use_int, [None, None], rep_sd_range)
        sd_min, sd_max = _sprite_int_sd_bounds(n, a, b, s_lo, s_hi)
    else:
        sd_min, sd_max = _sprite_cont_sd_bounds(n, min_f, max_f, mu_lo, mu_hi)
    if rep_sd_range[1] < sd_min - 1e-12:
        return _sprite_result(False, "sd_below_min", mean_v, sd_v, n, min_f, max_f, use_int, [sd_min, sd_max], rep_sd_range)
    if rep_sd_range[0] > sd_max + 1e-12:
        return _sprite_result(False, "sd_above_max", mean_v, sd_v, n, min_f, max_f, use_int, [sd_min, sd_max], rep_sd_range)
    return _sprite_result(True, "ok", mean_v, sd_v, n, min_f, max_f, use_int, [sd_min, sd_max], rep_sd_range)


def _log_choose(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def _fisher_exact_2x2(a, n1, c, n2):
    m1, n_tot = a + c, n1 + n2
    x_min, x_max = max(0, m1 - n2), min(n1, m1)
    if x_max - x_min > 50000:
        return None, None
    denom = _log_choose(n_tot, m1)
    log_obs = _log_choose(n1, a) + _log_choose(n2, m1 - a) - denom
    p_obs = math.exp(log_obs)
    p_two = 0.0
    p_left = 0.0
    p_right = 0.0
    for x in range(x_min, x_max + 1):
        lp = _log_choose(n1, x) + _log_choose(n2, m1 - x) - denom
        px = math.exp(lp)
        if lp <= log_obs + 1e-9 or px <= p_obs + 1e-12:
            p_two += px
        if x <= a:
            p_left += px
        if x >= a:
            p_right += px
    return min(1.0, p_two), min(1.0, p_left, p_right)


def _chi2_2x2(a, b, c, d):
    n1, n2, m1, m0 = a + b, c + d, a + c, b + d
    n_tot = n1 + n2
    denom = n1 * n2 * m1 * m0
    if denom == 0:
        return 0.0, 1.0, 0.0, 1.0
    diff = abs(a * d - b * c)
    p_chi2 = (n_tot * diff * diff) / denom
    y_diff = max(0.0, diff - 0.5 * n_tot)
    y_chi2 = (n_tot * y_diff * y_diff) / denom
    return p_chi2, stat_pvalue("chi2", p_chi2, df1=1), y_chi2, stat_pvalue("chi2", y_chi2, df1=1)


def _add_ratio_and_inv(cands, num, den):
    if den > 0.0:
        val = num / den
        cands.append(val)
        if val > 0.0:
            cands.append(1.0 / val)


def _ratios_2x2(a, b, c, d):
    has_zero = a == 0 or b == 0 or c == 0 or d == 0
    ah, bh, ch, dh = (a + 0.5, b + 0.5, c + 0.5, d + 0.5) if has_zero else (float(a), float(b), float(c), float(d))
    or_val = (ah * dh) / (bh * ch)
    or_cands = [or_val, 1.0 / or_val]
    _add_ratio_and_inv(or_cands, float(a * d), float(b * c))
    n1, n2 = a + b, c + d
    rr_val = ((a + 0.5) / (n1 + 1.0)) / ((c + 0.5) / (n2 + 1.0)) if (a == 0 or c == 0) else (a / n1) / (c / n2)
    rr_cands = [rr_val, 1.0 / rr_val]
    if a > 0 and c > 0:
        _add_ratio_and_inv(rr_cands, a / n1, c / n2)
    elif a == 0 and c > 0:
        rr_cands.append(0.0)
    return or_val, rr_val, or_cands, rr_cands


def _norm_2x2_kind(reported_kind):
    if reported_kind is None:
        return None, False
    k = re.sub(r"[^A-Z]", "", str(reported_kind).upper())
    if k in ("AOR", "ARR") or "ADJ" in k:
        return k, True
    if k in ("OR", "ODDSRATIO"):
        return "OR", False
    if k in ("RR", "RISKRATIO", "RELATIVERISK"):
        return "RR", False
    return k or None, True


def _match_2x2_est(rep_est, est_decimals, cands):
    eps = 0.5 * (10.0 ** (-est_decimals)) + 1e-9
    return any(abs(rep_est - cand) <= eps for cand in cands)


def _match_2x2_p_single(p_cand, op, rep_p, tol):
    if op == "=":
        return abs(p_cand - rep_p) <= tol + 1e-12
    if op == "<":
        return p_cand < rep_p + 1e-12
    if op == "<=":
        return p_cand <= rep_p + 1e-12
    if op == ">":
        return p_cand > rep_p - 1e-12
    return p_cand >= rep_p - 1e-12


def _match_2x2_p(rep_p, op, p_decimals, candidates):
    tol = 0.01 if p_decimals <= 2 else 0.5 * (10.0 ** (-p_decimals))
    return any(_match_2x2_p_single(c, op, rep_p, tol) for c in candidates if c is not None)


def _validate_2x2_counts(events1, total1, events2, total2):
    for val, name in ((events1, "events1"), (total1, "total1"), (events2, "events2"), (total2, "total2")):
        if isinstance(val, bool) or not isinstance(val, int):
            raise ValueError(name)
    if total1 < 1 or total2 < 1:
        raise ValueError("total")
    if not 0 <= events1 <= total1 or not 0 <= events2 <= total2:
        raise ValueError("events")


def _normalize_2x2_op(p_op):
    op = str(p_op or "=").strip().replace("≤", "<=").replace("≥", ">=")
    if op == "==":
        op = "="
    if op not in _OPERATORS:
        raise ValueError("p_op")
    return op


def check_two_by_two(
    events1,
    total1,
    events2,
    total2,
    *,
    reported_kind=None,
    reported_est=None,
    est_decimals=2,
    reported_p=None,
    p_op="=",
    p_decimals=3,
    one_tailed=False,
):
    """Verify 2x2 contingency table crude OR/RR and Fisher/Pearson/Yates p-values."""
    _validate_2x2_counts(events1, total1, events2, total2)
    op = _normalize_2x2_op(p_op)
    e_dec = _validate_nonneg_int_param(est_decimals, "est_decimals")
    p_dec = _validate_nonneg_int_param(p_decimals, "p_decimals")
    b, d = total1 - events1, total2 - events2
    fisher_p, fisher_one = _fisher_exact_2x2(events1, total1, events2, total2)
    p_chi2, pearson_p, y_chi2, yates_p = _chi2_2x2(events1, b, events2, d)
    or_val, rr_val, or_cands, rr_cands = _ratios_2x2(events1, b, events2, d)
    kind_norm, adjusted_exempt = _norm_2x2_kind(reported_kind)
    issues = []
    est_ok = None
    if reported_est is not None and not adjusted_exempt and kind_norm in ("OR", "RR"):
        rep_est, _ = _to_float_and_decimals(reported_est, e_dec)
        est_ok = _match_2x2_est(rep_est, e_dec, or_cands if kind_norm == "OR" else rr_cands)
        if not est_ok:
            issues.append(f"{kind_norm.lower()}_mismatch")
    p_ok = None
    if reported_p is not None:
        rep_p, _ = _to_float_and_decimals(reported_p, p_dec)
        if not 0.0 <= rep_p <= 1.0:
            raise ValueError("reported_p")
        p_cands = [fisher_p, pearson_p, yates_p]
        if one_tailed:
            p_cands.extend([fisher_one, 0.5 * pearson_p, 0.5 * yates_p])
        p_ok = _match_2x2_p(rep_p, op, p_dec, p_cands)
        if not p_ok:
            issues.append("p_mismatch")
    return {
        "consistent": not issues,
        "estConsistent": est_ok,
        "pConsistent": p_ok,
        "issues": issues,
        "events1": events1,
        "total1": total1,
        "events2": events2,
        "total2": total2,
        "or": or_val,
        "rr": rr_val,
        "fisherP": fisher_p,
        "fisherOneSidedP": fisher_one,
        "pearsonChi2": p_chi2,
        "pearsonP": pearson_p,
        "yatesChi2": y_chi2,
        "yatesP": yates_p,
        "adjustedExempt": adjusted_exempt,
    }


def _km_entry_row(entry, idx):
    if isinstance(entry, dict):
        arm = str(entry.get("arm") or entry.get("label") or entry.get("name") or f"Arm {idx + 1}")
        raw = entry["counts"] if "counts" in entry else entry.get("values")
        return arm, list(raw or [])
    if isinstance(entry, (list, tuple)):
        return f"Arm {idx + 1}", list(entry)
    raise ValueError("series_rows")


def _normalize_km_rows(series_rows):
    if isinstance(series_rows, dict):
        return [(str(k), list(v)) for k, v in series_rows.items()]
    if not isinstance(series_rows, (list, tuple)):
        raise ValueError("series_rows")
    if series_rows and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in series_rows):
        return [("Arm 1", list(series_rows))]
    return [_km_entry_row(entry, idx) for idx, entry in enumerate(series_rows)]


def _km_baseline_for(arm, idx, baseline_totals, num_rows):
    if baseline_totals is None:
        return None
    if isinstance(baseline_totals, dict):
        return baseline_totals.get(arm)
    if isinstance(baseline_totals, (list, tuple)):
        return baseline_totals[idx] if idx < len(baseline_totals) else None
    if isinstance(baseline_totals, int) and not isinstance(baseline_totals, bool) and num_rows == 1:
        return baseline_totals
    return None


def _km_check_arm(arm, counts, baseline):
    violations = []
    if not counts:
        return violations
    clean = []
    for val in counts:
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val < 0:
            raise ValueError("km_count")
        clean.append(int(val) if float(val).is_integer() else float(val))
    if baseline is not None and clean[0] > baseline:
        violations.append({
            "arm": arm, "kind": "exceeds_baseline", "index": 0,
            "prev": baseline, "value": clean[0], "baseline": baseline,
        })
    for t in range(1, len(clean)):
        if clean[t] > clean[t - 1]:
            violations.append({
                "arm": arm, "kind": "non_monotonic", "index": t,
                "prev": clean[t - 1], "value": clean[t], "baseline": baseline,
            })
    return violations


def check_km_at_risk(series_rows, *, baseline_totals=None, context_text=""):
    """Check Kaplan-Meier 'Number at risk' sequences for non-increasing monotonicity."""
    if _KM_SKIP_RE.search(context_text or ""):
        return {"consistent": True, "skipped": True, "skipReason": "delayed_entry_or_time_varying", "violations": []}
    rows = _normalize_km_rows(series_rows)
    violations = []
    for idx, (arm, counts) in enumerate(rows):
        base = _km_baseline_for(arm, idx, baseline_totals, len(rows))
        violations.extend(_km_check_arm(arm, counts, base))
    return {"consistent": not violations, "skipped": False, "violations": violations}
