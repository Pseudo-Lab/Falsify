"""Pseudo-Lab Falsify Season 13 verification gates (D1, D2, D3)."""
from __future__ import annotations

from .d1_numeric import check_numeric_claim, extract_numeric_claims, verify_d1_document
from .d2_citation import DictCitationResolver, LiveCitationResolver, check_citation, extract_citations, verify_d2_citations
from .d3_claim_anchor import check_claim_against_anchors, verify_d3_document
from .models import (
    DEFECT_TYPES,
    VALID_VERDICTS,
    VERDICT_DEFECT,
    VERDICT_NEEDS_REVIEW,
    VERDICT_VALID,
    GateFinding,
    GateVerdict,
    aggregate_verdict,
    normalize_verdict,
)

__all__ = [
    "DEFECT_TYPES",
    "DictCitationResolver",
    "GateFinding",
    "GateVerdict",
    "LiveCitationResolver",
    "VALID_VERDICTS",
    "VERDICT_DEFECT",
    "VERDICT_NEEDS_REVIEW",
    "VERDICT_VALID",
    "aggregate_verdict",
    "check_citation",
    "check_claim_against_anchors",
    "check_numeric_claim",
    "extract_citations",
    "extract_numeric_claims",
    "normalize_verdict",
    "verify_d1_document",
    "verify_d2_citations",
    "verify_d3_document",
]
