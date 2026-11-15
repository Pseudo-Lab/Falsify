"""Shared data models and label normalization for Falsify Season 13 gates."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Sequence

VERDICT_VALID = "맞음"
VERDICT_DEFECT = "아님"
VERDICT_NEEDS_REVIEW = "확인필요"
VALID_VERDICTS: tuple[str, ...] = (VERDICT_VALID, VERDICT_DEFECT, VERDICT_NEEDS_REVIEW)

DEFECT_TYPES: tuple[str, ...] = ("D1", "D2", "D3")

SCORE_COLUMNS: tuple[str, ...] = (
    "paper_id",
    "team",
    "judge_type",
    "model",
    "iteration",
    "location",
    "defect_type",
    "label",
    "evidence",
    "time_sec",
    "tokens",
    "is_holdout",
)

VERDICT_ALIASES: dict[str, str] = {
    "맞음": VERDICT_VALID,
    "correct": VERDICT_VALID,
    "consistent": VERDICT_VALID,
    "valid": VERDICT_VALID,
    "pass": VERDICT_VALID,
    "supported": VERDICT_VALID,
    "ok": VERDICT_VALID,
    "정상": VERDICT_VALID,
    "yes": VERDICT_VALID,
    "true": VERDICT_VALID,
    "아님": VERDICT_DEFECT,
    "incorrect": VERDICT_DEFECT,
    "inconsistent": VERDICT_DEFECT,
    "invalid": VERDICT_DEFECT,
    "fail": VERDICT_DEFECT,
    "block": VERDICT_DEFECT,
    "unsupported": VERDICT_DEFECT,
    "defect": VERDICT_DEFECT,
    "결함": VERDICT_DEFECT,
    "no": VERDICT_DEFECT,
    "false": VERDICT_DEFECT,
    "확인필요": VERDICT_NEEDS_REVIEW,
    "확인 필요": VERDICT_NEEDS_REVIEW,
    "needs_review": VERDICT_NEEDS_REVIEW,
    "needs review": VERDICT_NEEDS_REVIEW,
    "review": VERDICT_NEEDS_REVIEW,
    "unsure": VERDICT_NEEDS_REVIEW,
    "hold": VERDICT_NEEDS_REVIEW,
    "unknown": VERDICT_NEEDS_REVIEW,
    "?": VERDICT_NEEDS_REVIEW,
}


def normalize_verdict(label: str) -> str:
    """Normalize Korean or English verdict labels to canonical Season 13 labels."""
    key = (label or "").strip().lower()
    if key in VERDICT_ALIASES:
        return VERDICT_ALIASES[key]
    raise ValueError(f"Unsupported verdict label: {label!r}; expected one of {VALID_VERDICTS}")


@dataclass
class GateFinding:
    """Structured output produced by a verification gate (D1, D2, or D3).

    In claim-verification semantics:
    - ``맞음``: claim/citation/conclusion matches evidence.
    - ``아님``: defect detected (mismatch, fabricated citation, or unsupported claim).
    - ``확인필요``: missing anchor, ambiguous metadata, or lookup unavailable.
    """

    case_id: str
    defect_type: str
    verdict: str
    confidence: float
    evidence: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    location: str = ""
    paper_id: str = ""

    def __post_init__(self) -> None:
        self.verdict = normalize_verdict(self.verdict)
        self.defect_type = (self.defect_type or "").strip().upper()
        if not self.defect_type:
            raise ValueError("defect_type must be non-empty")
        if not (0.0 <= float(self.confidence) <= 1.0):
            raise ValueError(f"confidence must be in [0.0, 1.0], got {self.confidence!r}")
        self.confidence = float(self.confidence)

    @property
    def is_defect(self) -> bool:
        """Return True when this finding identifies a defect (verdict == '아님')."""
        return self.verdict == VERDICT_DEFECT

    def to_score_label(self, *, defect_perspective: bool = True) -> str:
        """Map gate verdict to ``tools/score.py`` Blue CSV label semantics.

        ``tools/score.py`` treats ``맞음``/``yes``/``defect`` as a flagged defect (TP/FP)
        and ``아님``/``no``/``ok`` as a clean/non-defect row.
        """
        if not defect_perspective:
            return self.verdict
        if self.verdict == VERDICT_DEFECT:
            return VERDICT_VALID
        if self.verdict == VERDICT_VALID:
            return VERDICT_DEFECT
        return VERDICT_NEEDS_REVIEW

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable dictionary representation."""
        data = asdict(self)
        data["is_defect"] = self.is_defect
        data["score_label"] = self.to_score_label(defect_perspective=True)
        return data

    def to_score_row(
        self,
        *,
        team: str = "blue-gates",
        judge_type: str = "rule",
        model: str = "falsify-gates-v1",
        iteration: int = 1,
        time_sec: float = 0.0,
        tokens: int = 0,
        is_holdout: bool = False,
        defect_perspective: bool = True,
    ) -> dict[str, Any]:
        """Build a CSV row dictionary matching ``tools/score.py`` REQUIRED_COLUMNS."""
        return {
            "paper_id": self.paper_id or self.case_id,
            "team": team,
            "judge_type": judge_type,
            "model": model,
            "iteration": str(iteration),
            "location": self.location or self.case_id,
            "defect_type": self.defect_type,
            "label": self.to_score_label(defect_perspective=defect_perspective),
            "evidence": self.reason,
            "time_sec": f"{time_sec:.2f}" if isinstance(time_sec, float) else str(time_sec),
            "tokens": str(tokens),
            "is_holdout": "true" if is_holdout else "false",
        }


GateVerdict = GateFinding


def aggregate_verdict(findings: Sequence[GateFinding]) -> str:
    """Aggregate multiple gate findings into a single overall verdict."""
    if not findings:
        return VERDICT_NEEDS_REVIEW
    verdicts = {f.verdict for f in findings}
    if VERDICT_DEFECT in verdicts:
        return VERDICT_DEFECT
    if VERDICT_NEEDS_REVIEW in verdicts:
        return VERDICT_NEEDS_REVIEW
    return VERDICT_VALID
