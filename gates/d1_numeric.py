"""Gate D1: Numeric consistency verification against Fact Card / Markdown tables."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from .models import VERDICT_DEFECT, VERDICT_NEEDS_REVIEW, VERDICT_VALID, GateFinding

_NUM = r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)"
_MEAN_SD_RE = re.compile(
    rf"(?P<mean>{_NUM})\s*(?:±|\+/-|\(\s*±\s*|\(\s*SD\s*[:=]?\s*)\s*(?P<sd>{_NUM})\)?",
    flags=re.I,
)
_CI_RE = re.compile(
    rf"(?:(?P<level>9[059])%\s*)?(?:CI|confidence\s+interval)\s*[:=,]?\s*[\[\(]?\s*(?P<low>{_NUM})\s*(?:,|to|–|—|-)\s*(?P<high>{_NUM})\s*[\]\)]?",
    flags=re.I,
)
_RATIO_RE = re.compile(
    rf"\b(?P<kind>HR|OR|RR|IRR|MD|SMD|beta|β)\s*(?:=|:|\bof\b)?\s*(?P<val>{_NUM})",
    flags=re.I,
)
_PCT_RE = re.compile(rf"(?P<val>{_NUM})\s*%")
_PVAL_RE = re.compile(rf"\bp(?:\s*-?\s*value)?\s*(?P<op><=|>=|=|<|>)\s*(?P<val>{_NUM})", flags=re.I)
_N_RE = re.compile(rf"\bn\s*=\s*(?P<val>\d+)\b", flags=re.I)
_SCALAR_MEAN_RE = re.compile(
    rf"\b(?:mean|median|average|value|score|reduction)\b[^.\n]{{0,45}}?\b(?:was|were|is|of|=|:)\s*(?P<val>{_NUM})",
    flags=re.I,
)
_TOKEN_RE = re.compile(r"[a-z0-9가-힣]+")

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "was", "were",
    "is", "are", "at", "by", "from", "that", "this", "group", "arm", "patients", "ci",
    "sd", "mean", "vs", "versus", "than", "between", "after", "before", "rate", "score",
})


@dataclass(frozen=True)
class NumericClaim:
    """A structured numeric claim extracted from manuscript prose."""

    kind: str  # mean_sd | percentage | ci | effect | p_value | sample_size
    raw: str
    values: tuple[str, ...]
    operator: str = "="
    context: str = ""
    location: str = ""
    tokens: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class TableRow:
    """Normalized representation of a Fact Card or Markdown table row."""

    table_id: str
    metric: str
    group: str
    fields: dict[str, str]
    tokens: frozenset[str]
    group_tokens: frozenset[str]


def _normalize_unicode_math(text: str) -> str:
    return (
        (text or "")
        .replace("−", "-")
        .replace("–", "-")
        .replace("—", "-")
        .replace("±", "±")
    )


def _tokenize(text: str) -> frozenset[str]:
    low = _normalize_unicode_math(text).lower()
    return frozenset(t for t in _TOKEN_RE.findall(low) if t not in _STOPWORDS and len(t) > 1)


def _decimal_places(num_str: str) -> int:
    s = num_str.strip().lstrip("+-")
    if "." not in s:
        return 0
    return len(s.split(".", 1)[1])


def _parse_float(num_str: str) -> float | None:
    try:
        val = float(_normalize_unicode_math(num_str).strip())
        return val if math.isfinite(val) else None
    except ValueError:
        return None


def is_value_consistent(claimed: str, reference: str | float | int, extra_tol: float = 0.0) -> bool:
    """Return True if ``claimed`` matches ``reference`` within half-ULP rounding tolerance."""
    c_val = _parse_float(str(claimed))
    r_str = str(reference)
    r_val = _parse_float(r_str)
    if c_val is None or r_val is None:
        return False
    d_c = _decimal_places(str(claimed))
    d_r = _decimal_places(r_str)
    half_ulp = 0.5 * (10.0 ** (-d_c)) if d_r > d_c else 0.0
    return abs(c_val - r_val) <= (half_ulp + extra_tol + 1e-9)


def _span_inside(span: tuple[int, int], occupied: list[tuple[int, int]]) -> bool:
    return any(s <= span[0] and span[1] <= e for s, e in occupied)


def _extract_from_line(line: str, location: str) -> list[NumericClaim]:
    norm = _normalize_unicode_math(line)
    tokens = _tokenize(norm)
    claims: list[NumericClaim] = []
    occupied: list[tuple[int, int]] = []

    def add(kind: str, span: tuple[int, int], raw: str, vals: tuple[str, ...], op: str = "=") -> None:
        occupied.append(span)
        claims.append(NumericClaim(kind, raw, vals, op, line.strip(), location, tokens))

    for m in _MEAN_SD_RE.finditer(norm):
        add("mean_sd", m.span(), m.group(0), (m.group("mean"), m.group("sd")))
    for m in _CI_RE.finditer(norm):
        add("ci", m.span(), m.group(0), (m.group("low"), m.group("high")))
    for m in _RATIO_RE.finditer(norm):
        add("effect", m.span(), m.group(0), (m.group("val"),), op=m.group("kind").upper())
    for m in _PVAL_RE.finditer(norm):
        add("p_value", m.span(), m.group(0), (m.group("val"),), op=m.group("op"))
    for m in _N_RE.finditer(norm):
        add("sample_size", m.span(), m.group(0), (m.group("val"),))
    for m in _PCT_RE.finditer(norm):
        if not (m.group(0).startswith(("95%", "90%", "99%")) and _span_inside(m.span(), occupied)):
            add("percentage", m.span(), m.group(0), (m.group("val"),))
    for m in _SCALAR_MEAN_RE.finditer(norm):
        if not _span_inside(m.span("val"), occupied):
            add("mean", m.span(), m.group(0), (m.group("val"),))
    return claims


def extract_numeric_claims(text: str, *, default_location: str = "") -> list[NumericClaim]:
    """Extract numeric claims from prose lines, ignoring Markdown tables and HTML comments."""
    claims: list[NumericClaim] = []
    in_comment = False
    for idx, raw_line in enumerate((text or "").splitlines(), 1):
        stripped = raw_line.strip()
        if stripped.startswith("<!--"):
            in_comment = not stripped.endswith("-->")
            continue
        if in_comment:
            if "-->" in stripped:
                in_comment = False
            continue
        if not stripped or stripped.startswith("|") or stripped.startswith("#"):
            continue
        loc = default_location or f"L{idx}"
        claims.extend(_extract_from_line(stripped, loc))
    return claims


def parse_markdown_tables(md_text: str) -> list[dict[str, Any]]:
    """Parse Markdown pipe tables into Fact Card compatible table dictionaries."""
    lines = (md_text or "").splitlines()
    tables: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            headers = [c.strip().lower() for c in lines[i].strip().strip("|").split("|")]
            i += 2
            rows: list[dict[str, Any]] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                row = {headers[k]: cells[k] for k in range(min(len(headers), len(cells)))}
                rows.append(_coerce_markdown_row(row))
                i += 1
            tables.append({"table_id": f"md_table_{len(tables) + 1}", "rows": rows})
        else:
            i += 1
    return tables


def _coerce_markdown_row(raw: dict[str, str]) -> dict[str, Any]:
    row: dict[str, Any] = dict(raw)
    for key in ("metric", "outcome", "variable", "measure", "endpoint"):
        if key in raw and "metric" not in row:
            row["metric"] = raw[key]
    for key in ("group", "arm", "cohort"):
        if key in raw and "group" not in row:
            row["group"] = raw[key]
    if "value" in raw:
        m = _MEAN_SD_RE.search(raw["value"])
        if m:
            row.setdefault("mean", m.group("mean"))
            row.setdefault("sd", m.group("sd"))
    return row


def _row_to_fields(raw_row: dict[str, Any]) -> dict[str, str]:
    fields: dict[str, str] = {}
    for k, v in raw_row.items():
        if v is None or v == "":
            continue
        kl = k.strip().lower()
        if kl == "ci" and isinstance(v, (list, tuple)) and len(v) == 2:
            fields["ci_low"] = str(v[0])
            fields["ci_high"] = str(v[1])
        elif kl in ("ci_lower", "ci_low", "lower_ci"):
            fields["ci_low"] = str(v)
        elif kl in ("ci_upper", "ci_high", "upper_ci"):
            fields["ci_high"] = str(v)
        elif kl in ("pct", "percent", "percentage"):
            fields["percentage"] = str(v).rstrip("%")
        elif kl in ("p", "p_value", "pval"):
            fields["p_value"] = str(v)
        elif kl in ("value", "estimate", "effect", "hr", "or", "rr", "md", "smd", "beta"):
            fields[kl] = str(v)
            fields.setdefault("effect", str(v))
        else:
            fields[kl] = str(v)
    return fields


def normalize_fact_card_tables(fact_card: dict[str, Any] | None, tables_markdown: str | None = None) -> list[TableRow]:
    """Convert Fact Card tables and optional Markdown tables into searchable TableRow items."""
    raw_tables = list((fact_card or {}).get("tables") or [])
    if tables_markdown:
        raw_tables.extend(parse_markdown_tables(tables_markdown))
    rows: list[TableRow] = []
    for t_idx, tbl in enumerate(raw_tables, 1):
        tid = str(tbl.get("table_id") or tbl.get("id") or f"T{t_idx}")
        title_tokens = _tokenize(str(tbl.get("title") or ""))
        for raw_row in tbl.get("rows") or []:
            metric = str(raw_row.get("metric") or raw_row.get("outcome") or raw_row.get("name") or "")
            group = str(raw_row.get("group") or raw_row.get("arm") or "")
            fields = _row_to_fields(raw_row)
            rows.append(
                TableRow(
                    table_id=tid,
                    metric=metric,
                    group=group,
                    fields=fields,
                    tokens=_tokenize(metric) | title_tokens,
                    group_tokens=_tokenize(group),
                )
            )
    return rows


def _best_matching_rows(claim: NumericClaim, rows: list[TableRow]) -> list[TableRow]:
    scored: list[tuple[int, int, TableRow]] = []
    for r in rows:
        metric_hits = len(claim.tokens & r.tokens)
        group_hits = len(claim.tokens & r.group_tokens)
        if metric_hits > 0:
            scored.append((metric_hits, group_hits, r))
    if not scored:
        return []
    max_metric = max(s[0] for s in scored)
    top_metric = [s for s in scored if s[0] == max_metric]
    max_group = max(s[1] for s in top_metric)
    return [s[2] for s in top_metric if s[1] == max_group]


def _check_ci_claim(claim: NumericClaim, row: TableRow, tol: float) -> tuple[str, str]:
    low_s, high_s = claim.values
    low_v, high_v = _parse_float(low_s), _parse_float(high_s)
    if low_v is not None and high_v is not None and low_v > high_v:
        return VERDICT_DEFECT, f"CI bounds are reversed: [{low_s}, {high_s}]"
    r_low, r_high = row.fields.get("ci_low"), row.fields.get("ci_high")
    if r_low is None or r_high is None:
        return VERDICT_NEEDS_REVIEW, f"Table {row.table_id} row '{row.metric}' has no CI bounds"
    if is_value_consistent(low_s, r_low, tol) and is_value_consistent(high_s, r_high, tol):
        return VERDICT_VALID, f"CI [{low_s}, {high_s}] matches table {row.table_id} [{r_low}, {r_high}]"
    if is_value_consistent(low_s, r_high, tol) and is_value_consistent(high_s, r_low, tol):
        return VERDICT_DEFECT, f"CI bounds swapped vs table {row.table_id}: claimed [{low_s}, {high_s}] vs table [{r_low}, {r_high}]"
    return VERDICT_DEFECT, f"CI mismatch vs table {row.table_id} ({row.metric}): claimed [{low_s}, {high_s}] vs table [{r_low}, {r_high}]"


def _check_mean_sd_claim(claim: NumericClaim, row: TableRow, tol: float) -> tuple[str, str]:
    c_mean, c_sd = claim.values
    r_mean = row.fields.get("mean") or row.fields.get("value")
    r_sd = row.fields.get("sd")
    if r_mean is None:
        return VERDICT_NEEDS_REVIEW, f"Table {row.table_id} row '{row.metric}' lacks mean/value"
    if not is_value_consistent(c_mean, r_mean, tol):
        return VERDICT_DEFECT, f"Mean mismatch for '{row.metric}': prose {c_mean} vs table {r_mean}"
    if r_sd is not None and not is_value_consistent(c_sd, r_sd, tol):
        return VERDICT_DEFECT, f"SD mismatch for '{row.metric}': prose {c_sd} vs table {r_sd}"
    return VERDICT_VALID, f"Mean/SD {c_mean} (±{c_sd}) matches table {row.table_id} ({r_mean} ± {r_sd})"


def _check_p_value_claim(claim: NumericClaim, row: TableRow, tol: float) -> tuple[str, str]:
    c_val_s = claim.values[0]
    c_val = _parse_float(c_val_s)
    r_p_s = row.fields.get("p_value")
    if r_p_s is None or c_val is None:
        return VERDICT_NEEDS_REVIEW, f"Table {row.table_id} row '{row.metric}' lacks p_value"
    r_clean = r_p_s.lstrip("<>=").strip()
    r_val = _parse_float(r_clean)
    if r_val is None:
        return VERDICT_NEEDS_REVIEW, f"Unparseable table p_value {r_p_s!r}"
    if claim.operator == "<" and not r_p_s.startswith("<"):
        if r_val < c_val:
            return VERDICT_VALID, f"p < {c_val_s} is consistent with table p = {r_p_s}"
        return VERDICT_DEFECT, f"p < {c_val_s} contradicted by table p = {r_p_s}"
    if is_value_consistent(c_val_s, r_clean, tol):
        return VERDICT_VALID, f"p-value {c_val_s} matches table {row.table_id} ({r_p_s})"
    return VERDICT_DEFECT, f"p-value mismatch for '{row.metric}': prose {c_val_s} vs table {r_p_s}"


def _check_scalar_claim(claim: NumericClaim, row: TableRow, tol: float) -> tuple[str, str]:
    c_val_s = claim.values[0]
    key_map = {
        "percentage": ("percentage", "value"),
        "mean": ("mean", "value"),
        "effect": (claim.operator.lower(), "effect", "value"),
        "sample_size": ("n", "sample_size"),
    }
    candidates = key_map.get(claim.kind, ("value",))
    r_val_s = next((row.fields[k] for k in candidates if k in row.fields), None)
    if r_val_s is None:
        return VERDICT_NEEDS_REVIEW, f"Table {row.table_id} row '{row.metric}' lacks {claim.kind}"
    c_val, r_val = _parse_float(c_val_s), _parse_float(r_val_s)
    if is_value_consistent(c_val_s, r_val_s, tol):
        return VERDICT_VALID, f"{claim.kind} {c_val_s} matches table {row.table_id} ({r_val_s})"
    if c_val is not None and r_val is not None and r_val != 0 and abs(c_val + r_val) <= 1e-6:
        return VERDICT_DEFECT, f"Sign mismatch for '{row.metric}': prose {c_val_s} vs table {r_val_s}"
    return VERDICT_DEFECT, f"{claim.kind} mismatch for '{row.metric}' ({row.group or 'overall'}): prose {c_val_s} vs table {r_val_s}"


def _reconcile_claim(claim: NumericClaim, rows: list[TableRow], tol: float) -> tuple[str, str, dict[str, Any]]:
    matched = _best_matching_rows(claim, rows)
    if not matched:
        return VERDICT_NEEDS_REVIEW, f"No matching metric row found in table for {claim.raw!r}", {"claim": claim.raw}
    row = matched[0]
    if claim.kind == "ci":
        verdict, reason = _check_ci_claim(claim, row, tol)
    elif claim.kind == "mean_sd":
        verdict, reason = _check_mean_sd_claim(claim, row, tol)
    elif claim.kind == "p_value":
        verdict, reason = _check_p_value_claim(claim, row, tol)
    else:
        verdict, reason = _check_scalar_claim(claim, row, tol)

    if verdict == VERDICT_DEFECT:
        other_rows = [r for r in rows if r is not row and len(claim.tokens & r.tokens) >= len(row.tokens & claim.tokens)]
        for alt in other_rows:
            alt_v, _ = _check_scalar_claim(claim, alt, tol) if claim.kind not in ("ci", "mean_sd", "p_value") else (VERDICT_NEEDS_REVIEW, "")
            if alt_v == VERDICT_VALID and alt.group and row.group and alt.group != row.group:
                reason = f"Group mismatch for '{row.metric}': prose mentions '{row.group}' with '{alt.group}' value ({claim.values[0]})"
                break

    evidence = {
        "claim": claim.raw,
        "kind": claim.kind,
        "table_id": row.table_id,
        "metric": row.metric,
        "group": row.group,
        "table_fields": row.fields,
    }
    return verdict, reason, evidence


def check_numeric_claim(
    claim_text: str,
    fact_card: dict[str, Any] | None,
    *,
    case_id: str = "d1-case",
    location: str = "",
    paper_id: str = "",
    tables_markdown: str | None = None,
    tolerance: float = 0.0,
) -> GateFinding:
    """Verify numeric claims in a prose snippet against Fact Card / Markdown tables."""
    rows = normalize_fact_card_tables(fact_card, tables_markdown=tables_markdown)
    claims = extract_numeric_claims(claim_text, default_location=location)
    if not claims:
        return GateFinding(
            case_id=case_id,
            defect_type="D1",
            verdict=VERDICT_NEEDS_REVIEW,
            confidence=0.3,
            evidence={"claim_text": claim_text},
            reason="No numeric claims extracted from prose",
            location=location,
            paper_id=paper_id,
        )

    results = [_reconcile_claim(c, rows, tolerance) for c in claims]
    defects = [r for r in results if r[0] == VERDICT_DEFECT]
    reviews = [r for r in results if r[0] == VERDICT_NEEDS_REVIEW]
    if defects:
        v, reason, ev = defects[0]
        conf = 0.95
    elif reviews and len(reviews) == len(results):
        v, reason, ev = reviews[0]
        conf = 0.45
    elif reviews:
        v, reason, ev = reviews[0]
        conf = 0.55
    else:
        v, reason, ev = results[0]
        conf = 0.92
    return GateFinding(
        case_id=case_id,
        defect_type="D1",
        verdict=v,
        confidence=conf,
        evidence={"matched": ev, "checks_count": len(results)},
        reason=reason,
        location=location or claims[0].location,
        paper_id=paper_id or str((fact_card or {}).get("paper_id") or ""),
    )


def verify_d1_document(
    document_text: str,
    fact_card: dict[str, Any] | None,
    *,
    paper_id: str = "",
    tables_markdown: str | None = None,
    tolerance: float = 0.0,
) -> list[GateFinding]:
    """Run D1 numeric verification across all prose claims in a document."""
    rows = normalize_fact_card_tables(fact_card, tables_markdown=tables_markdown or document_text)
    claims = extract_numeric_claims(document_text)
    pid = paper_id or str((fact_card or {}).get("paper_id") or "")
    findings: list[GateFinding] = []
    for idx, claim in enumerate(claims, 1):
        verdict, reason, evidence = _reconcile_claim(claim, rows, tolerance)
        conf = 0.95 if verdict == VERDICT_DEFECT else (0.9 if verdict == VERDICT_VALID else 0.45)
        findings.append(
            GateFinding(
                case_id=f"{pid or 'doc'}-d1-{idx}",
                defect_type="D1",
                verdict=verdict,
                confidence=conf,
                evidence=evidence,
                reason=reason,
                location=claim.location,
                paper_id=pid,
            )
        )
    return findings
