"""Gate D3: Claim-to-anchor evidence alignment verification."""
from __future__ import annotations

import re
from typing import Any, Callable

from .models import (
    VERDICT_DEFECT,
    VERDICT_NEEDS_REVIEW,
    VERDICT_VALID,
    GateFinding,
    normalize_verdict,
)

_TOKEN_RE = re.compile(r"[a-z0-9가-힣]+")
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "that", "this",
    "was", "were", "is", "are", "by", "from", "at", "as", "among", "between", "all",
    "patients", "participants", "study", "trial", "treatment", "intervention", "group",
})

_NULL_PHRASES = (
    "no significant difference",
    "not statistically significant",
    "did not significantly",
    "did not differ",
    "no difference",
    "failed to show",
    "failed to demonstrate",
    "non-significant",
    "nonsignificant",
    "comparable between",
    "유의한 차이가 없",
    "유의하지 않",
    "차이가 없었",
)

_SIG_CUES = (
    "statistically significant",
    "significantly",
    "demonstrated efficacy",
    "proved",
    "proven",
    "established",
    "유의하게",
    "유의미하게",
    "입증",
    "개선했다",
    "감소시켰다",
)

_POSITIVE_CUES = (
    "improved", "improve", "improvement", "reduced", "reduce", "reduction",
    "decreased", "decrease", "lowered", "lower", "beneficial", "benefit",
    "effective", "efficacy", "superior", "increased", "increase", "enhanced",
    "개선", "감소", "향상", "효과", "우월", "증가",
)

_HARM_CUES = (
    "worsened", "worsen", "inferior", "harm", "adverse increase", "악화", "열등",
)

_INCREASE_CUES = ("increased", "increase", "higher", "elevated", "증가", "상승")
_DECREASE_CUES = ("decreased", "decrease", "reduced", "reduce", "reduction", "lowered", "lower", "감소", "저하")

_CAUSAL_CUES = (
    "caused", "causes", "cause ", "causally", "proves that", "proved that",
    "directly leads to", "directly led to", "established causality", "causal effect",
    "원인", "인과적", "유발한다", "유발했다",
)

_HEDGE_CUES = (
    "associated with", "correlated with", "may ", "might ", "suggests", "exploratory",
    "preliminary", "trend", "연관", "시사", "경향",
)

_OBSERVATIONAL_DESIGNS = frozenset({
    "observational", "cohort", "cross-sectional", "case-control", "retrospective",
    "registry", "ecological",
})

_SUBGROUP_MARKERS = (
    "subgroup", "subset", "stratified", "only among", "restricted to", "aged", "with baseline",
    "하위집단", "아집단", "제한된",
)


def _tokens(text: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall((text or "").lower()) if t not in _STOPWORDS and len(t) > 1}


def _has_any(text_low: str, phrases: tuple[str, ...]) -> bool:
    return any(p in text_low for p in phrases)


def _anchor_list(fact_card: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not fact_card:
        return []
    anchors = list(fact_card.get("claim_anchors") or [])
    for key in ("primary_outcomes", "results"):
        extra = fact_card.get(key)
        if isinstance(extra, list):
            anchors.extend(extra)
    return anchors


def _anchor_is_significant(anchor: dict[str, Any]) -> bool | None:
    if anchor.get("statistically_significant") is not None:
        return bool(anchor["statistically_significant"])
    alpha = float(anchor.get("alpha", 0.05))
    p_val = anchor.get("p_value")
    if p_val is not None:
        try:
            return float(str(p_val).lstrip("<>=").strip()) < alpha
        except ValueError:
            pass
    ci = anchor.get("ci")
    null_val = anchor.get("null_value")
    if isinstance(ci, (list, tuple)) and len(ci) == 2 and null_val is not None:
        try:
            low, high = float(ci[0]), float(ci[1])
            nv = float(null_val)
            return not (low <= nv <= high)
        except (TypeError, ValueError):
            pass
    return None


def _match_anchors(claim_text: str, anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    c_toks = _tokens(claim_text)
    scored: list[tuple[int, dict[str, Any]]] = []
    for anc in anchors:
        ep = str(anc.get("primary_endpoint") or anc.get("endpoint") or anc.get("outcome") or "")
        kws = " ".join(str(k) for k in (anc.get("keywords") or []))
        a_toks = _tokens(f"{ep} {kws}")
        overlap = len(c_toks & a_toks)
        if overlap > 0:
            scored.append((overlap + (1 if anc.get("is_primary") else 0), anc))
    if not scored:
        return []
    best = max(s[0] for s in scored)
    return [s[1] for s in scored if s[0] == best]


def _classify_claim(claim_text: str) -> dict[str, Any]:
    low = (claim_text or "").lower()
    is_null_claim = _has_any(low, _NULL_PHRASES)
    claims_sig = _has_any(low, _SIG_CUES) and not is_null_claim
    claims_benefit = _has_any(low, _POSITIVE_CUES) and not is_null_claim
    claims_harm = _has_any(low, _HARM_CUES) and not is_null_claim
    claims_increase = _has_any(low, _INCREASE_CUES) and not is_null_claim
    claims_decrease = _has_any(low, _DECREASE_CUES) and not is_null_claim
    claims_causal = _has_any(low, _CAUSAL_CUES) and not _has_any(low, _HEDGE_CUES)
    return {
        "is_null": is_null_claim,
        "significant": claims_sig,
        "benefit": claims_benefit,
        "harm": claims_harm,
        "increase": claims_increase,
        "decrease": claims_decrease,
        "causal": claims_causal,
    }


def _check_subgroup_scope(claim_text: str, anchor: dict[str, Any]) -> bool:
    cond = (anchor.get("subgroup_condition") or "").strip()
    if not cond:
        return True
    c_toks = _tokens(claim_text)
    s_toks = _tokens(cond)
    if s_toks and len(c_toks & s_toks) >= min(2, len(s_toks)):
        return True
    low = claim_text.lower()
    return _has_any(low, _SUBGROUP_MARKERS) and bool(c_toks & s_toks)


def _direction_conflict(direction: str, parsed: dict[str, Any]) -> str | None:
    if direction in ("decrease", "lower", "reduction") and parsed["increase"] and not parsed["decrease"]:
        return "Direction mismatch: anchor shows decrease/reduction but claim asserts increase"
    if direction in ("increase", "higher") and parsed["decrease"] and not parsed["increase"]:
        return "Direction mismatch: anchor shows increase but claim asserts decrease"
    if direction == "harm" and parsed["benefit"]:
        return "Direction mismatch: anchor shows harm but claim asserts benefit"
    if direction == "benefit" and parsed["harm"]:
        return "Direction mismatch: anchor shows benefit but claim asserts harm"
    return None


def _evaluate_null_anchor(anchor: dict[str, Any], parsed: dict[str, Any]) -> tuple[str, float, str]:
    if parsed["significant"] or parsed["benefit"] or parsed["harm"]:
        return VERDICT_DEFECT, 0.95, f"Non-significant/null anchor (p={anchor.get('p_value')}, ci={anchor.get('ci')}) overstated as significant effect"
    if parsed["is_null"]:
        return VERDICT_VALID, 0.9, "Conclusion accurately reflects null/non-significant outcome"
    return VERDICT_NEEDS_REVIEW, 0.45, "Conclusion direction unclear against null anchor"


def _evaluate_directional_anchor(
    direction: str,
    is_sig: bool | None,
    parsed: dict[str, Any],
    has_effect_claim: bool,
) -> tuple[str, float, str]:
    dir_err = _direction_conflict(direction, parsed)
    if dir_err:
        return VERDICT_DEFECT, 0.94, dir_err
    if is_sig is True and parsed["is_null"]:
        return VERDICT_DEFECT, 0.9, "Anchor shows statistically significant effect, but conclusion claims no difference"
    if is_sig is True and has_effect_claim:
        return VERDICT_VALID, 0.91, "Conclusion direction, significance, and scope align with anchor"
    return VERDICT_NEEDS_REVIEW, 0.45, "Insufficient alignment cues between claim and anchor"


def _evaluate_rule(claim_text: str, anchor: dict[str, Any]) -> tuple[str, float, str]:
    parsed = _classify_claim(claim_text)
    design = str(anchor.get("design") or "").strip().lower()
    direction = str(anchor.get("effect_direction") or "").strip().lower()
    is_sig = _anchor_is_significant(anchor)

    if not direction and is_sig is None:
        return VERDICT_NEEDS_REVIEW, 0.4, "Anchor lacks both effect_direction and significance metadata"
    if design in _OBSERVATIONAL_DESIGNS and parsed["causal"]:
        return VERDICT_DEFECT, 0.93, f"Causal claim from observational design ({design})"
    has_effect_claim = any(parsed[k] for k in ("benefit", "significant", "increase", "decrease"))
    if not _check_subgroup_scope(claim_text, anchor) and has_effect_claim:
        return VERDICT_DEFECT, 0.91, f"Subgroup condition omitted in general conclusion ({anchor.get('subgroup_condition')})"
    if is_sig is False or direction in ("null", "no_difference", "none"):
        return _evaluate_null_anchor(anchor, parsed)
    return _evaluate_directional_anchor(direction, is_sig, parsed, has_effect_claim)


def _invoke_llm_judge(
    llm_judge: Callable[[str, list[dict[str, Any]]], Any],
    claim_text: str,
    anchors: list[dict[str, Any]],
    case_id: str,
    location: str,
    paper_id: str,
) -> GateFinding:
    raw = llm_judge(claim_text, anchors)
    if isinstance(raw, GateFinding):
        return raw
    if isinstance(raw, dict):
        return GateFinding(
            case_id=case_id,
            defect_type="D3",
            verdict=normalize_verdict(str(raw.get("verdict", VERDICT_NEEDS_REVIEW))),
            confidence=float(raw.get("confidence", 0.75)),
            evidence={"judge": "llm_judge", "raw": raw},
            reason=str(raw.get("reason") or "Evaluated via llm_judge hook"),
            location=location,
            paper_id=paper_id,
        )
    return GateFinding(
        case_id=case_id,
        defect_type="D3",
        verdict=normalize_verdict(str(raw)),
        confidence=0.75,
        evidence={"judge": "llm_judge"},
        reason="Evaluated via llm_judge hook",
        location=location,
        paper_id=paper_id,
    )


def check_claim_against_anchors(
    claim_text: str,
    fact_card: dict[str, Any] | None,
    *,
    case_id: str = "d3-case",
    location: str = "",
    paper_id: str = "",
    llm_judge: Callable[[str, list[dict[str, Any]]], Any] | None = None,
    judge_mode: str = "fallback",
) -> GateFinding:
    """Verify a conclusion claim against Fact Card ``claim_anchors``."""
    anchors = _anchor_list(fact_card)
    pid = paper_id or str((fact_card or {}).get("paper_id") or "")
    matched = _match_anchors(claim_text, anchors)

    if llm_judge is not None and judge_mode == "always":
        return _invoke_llm_judge(llm_judge, claim_text, matched or anchors, case_id, location, pid)

    if not matched:
        if llm_judge is not None:
            return _invoke_llm_judge(llm_judge, claim_text, anchors, case_id, location, pid)
        return GateFinding(
            case_id=case_id,
            defect_type="D3",
            verdict=VERDICT_NEEDS_REVIEW,
            confidence=0.35,
            evidence={"claim": claim_text, "anchors_checked": len(anchors)},
            reason="Unanchored claim: no matching endpoint found in Fact Card claim_anchors",
            location=location,
            paper_id=pid,
        )

    anchor = matched[0]
    verdict, conf, reason = _evaluate_rule(claim_text, anchor)
    if verdict == VERDICT_NEEDS_REVIEW and llm_judge is not None:
        return _invoke_llm_judge(llm_judge, claim_text, matched, case_id, location, pid)

    return GateFinding(
        case_id=case_id,
        defect_type="D3",
        verdict=verdict,
        confidence=conf,
        evidence={
            "claim": claim_text,
            "anchor_id": anchor.get("anchor_id"),
            "endpoint": anchor.get("primary_endpoint") or anchor.get("endpoint"),
            "design": anchor.get("design"),
            "p_value": anchor.get("p_value"),
            "ci": anchor.get("ci"),
            "subgroup_condition": anchor.get("subgroup_condition"),
        },
        reason=reason,
        location=location,
        paper_id=pid,
    )


def extract_conclusion_claims(document_text: str) -> list[tuple[str, str]]:
    """Extract (location, sentence) pairs from Discussion/Conclusion sections."""
    lines = (document_text or "").splitlines()
    in_section = False
    claims: list[tuple[str, str]] = []
    for idx, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith("#"):
            in_section = bool(re.match(r"^#{1,4}\s+(discussion|conclusion|conclusions|고찰|결론)\b", stripped, flags=re.I))
            continue
        if in_section and stripped and not stripped.startswith("|") and not stripped.startswith("<!--"):
            for sent in re.split(r"(?<=[.!?])\s+", stripped):
                if len(sent.strip()) >= 15:
                    claims.append((f"L{idx}", sent.strip()))
    return claims


def verify_d3_document(
    document_text: str,
    fact_card: dict[str, Any] | None,
    *,
    paper_id: str = "",
    llm_judge: Callable[[str, list[dict[str, Any]]], Any] | None = None,
    judge_mode: str = "fallback",
) -> list[GateFinding]:
    """Run D3 claim-anchor verification across Discussion/Conclusion claims."""
    pid = paper_id or str((fact_card or {}).get("paper_id") or "")
    claims = extract_conclusion_claims(document_text)
    findings: list[GateFinding] = []
    for idx, (loc, sent) in enumerate(claims, 1):
        findings.append(
            check_claim_against_anchors(
                sent,
                fact_card,
                case_id=f"{pid or 'doc'}-d3-{idx}",
                location=loc,
                paper_id=pid,
                llm_judge=llm_judge,
                judge_mode=judge_mode,
            )
        )
    return findings
