"""Validators for Red attack packages (JSON) and Blue predictions (CSV)."""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
import sys
from typing import Any, Sequence

if __package__ in (None, ""):
    _ROOT = str(pathlib.Path(__file__).resolve().parents[1])
    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)

from corpus.validate_corpus import CorpusValidationError, validate_against_schema
from gates.models import DEFECT_TYPES, SCORE_COLUMNS, normalize_verdict

DEFAULT_SCHEMA_PATH = pathlib.Path(__file__).resolve().parent / "schema.json"

SCORE_LABEL_ALIASES = frozenset({
    "맞음", "yes", "true", "defect", "y", "결함",
    "아님", "no", "false", "ok", "n", "정상",
    "확인필요", "확인 필요", "unsure", "review", "?",
})
VALID_HOLDOUT_VALUES = frozenset({"", "true", "false", "1", "0", "yes", "no", "y", "n", "예", "홀드아웃", "holdout"})
LEAKAGE_PATTERNS = (
    re.compile(r"\bfalsify-keys\b", flags=re.I),
    re.compile(r"\bintended_label\b", flags=re.I),
    re.compile(r"\banswer_key\b", flags=re.I),
    re.compile(r"\bground_truth\b", flags=re.I),
    re.compile(r"<!--\s*ANSWER_KEY", flags=re.I),
    re.compile(r'"why_hard"\s*:', flags=re.I),
    re.compile(r'"how_to_catch"\s*:', flags=re.I),
)


class SubmissionValidationError(ValueError):
    """Raised when a Red JSON or Blue CSV submission fails validation."""


def load_schema(schema_path: pathlib.Path | None = None) -> dict[str, Any]:
    path = schema_path or DEFAULT_SCHEMA_PATH
    return json.loads(path.read_text(encoding="utf-8"))


def check_no_answer_key_leakage(text: str, *, field_name: str = "blind_input") -> None:
    """Reject blind Blue text or quotes that leak answer-key metadata."""
    for pat in LEAKAGE_PATTERNS:
        if pat.search(text or ""):
            raise SubmissionValidationError(
                f"{field_name}: potential answer-key leakage detected (matched {pat.pattern!r})"
            )


def _validate_blind_field(blind: Any, base_dir: pathlib.Path | None) -> None:
    if not isinstance(blind, str) or not blind.strip():
        return
    check_no_answer_key_leakage(blind, field_name="$.blind_input")
    if base_dir is not None and len(blind) < 260 and ("\n" not in blind):
        candidate = (base_dir / blind).resolve()
        if candidate.exists() and candidate.is_file():
            check_no_answer_key_leakage(candidate.read_text(encoding="utf-8"), field_name=f"blind_file:{blind}")


def validate_red_submission(
    data: Any,
    schema: dict[str, Any] | None = None,
    *,
    base_dir: pathlib.Path | None = None,
) -> None:
    """Validate a Red attack JSON package."""
    if not isinstance(data, dict):
        raise SubmissionValidationError("Red submission must be a JSON object")
    try:
        validate_against_schema(data, schema or load_schema())
    except CorpusValidationError as exc:
        raise SubmissionValidationError(str(exc)) from exc

    dtype = str(data["defect_type"]).strip().upper()
    detector = data.get("detector_spec") or data.get("custom_detector")
    if dtype not in DEFECT_TYPES and not str(detector or "").strip():
        raise SubmissionValidationError(
            f"$.defect_type: custom defect type {data['defect_type']!r} requires a non-empty detector_spec/custom_detector"
        )

    try:
        normalize_verdict(str(data["intended_label"]))
    except ValueError as exc:
        raise SubmissionValidationError(f"$.intended_label: {exc}") from exc

    check_no_answer_key_leakage(str(data["target_quote"]), field_name="$.target_quote")
    _validate_blind_field(data.get("blind_input"), base_dir)


def validate_blue_csv(csv_path: pathlib.Path) -> int:
    """Validate a Blue prediction CSV against ``tools/score.py`` column, label, and uniqueness rules."""
    with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        fields = [c.strip() for c in (reader.fieldnames or [])]
        missing = [c for c in SCORE_COLUMNS if c not in fields]
        if missing:
            raise SubmissionValidationError(f"{csv_path}: missing required score.py columns: {missing}")

        seen_case_ids: set[str] = set()
        seen_keys: set[tuple[str, str, str, str, str]] = set()
        row_count = 0

        for line_no, raw in enumerate(reader, 2):
            row = {(k or "").strip(): (v or "").strip() for k, v in raw.items() if k is not None}
            if not any(row.values()):
                continue
            row_count += 1
            _validate_blue_row(row, csv_path, line_no, seen_case_ids, seen_keys, has_case_id="case_id" in fields)

    if row_count == 0:
        raise SubmissionValidationError(f"{csv_path}: CSV contains 0 prediction rows")
    return row_count


def _validate_blue_numeric_fields(row: dict[str, str], csv_path: pathlib.Path, line_no: int) -> int:
    try:
        it = int(row.get("iteration") or "1")
    except ValueError as exc:
        raise SubmissionValidationError(f"{csv_path} line {line_no}: non-integer iteration {row.get('iteration')!r}") from exc
    if it < 1:
        raise SubmissionValidationError(f"{csv_path} line {line_no}: iteration must be >= 1")
    for num_col in ("time_sec", "tokens"):
        val = row.get(num_col, "")
        if val:
            try:
                if float(val) < 0:
                    raise ValueError
            except ValueError as exc:
                raise SubmissionValidationError(f"{csv_path} line {line_no}: invalid {num_col} {val!r}") from exc
    return it


def _validate_blue_row(
    row: dict[str, str],
    csv_path: pathlib.Path,
    line_no: int,
    seen_case_ids: set[str],
    seen_keys: set[tuple[str, str, str, str, str]],
    *,
    has_case_id: bool,
) -> None:
    for req_col in ("paper_id", "team", "location", "defect_type"):
        if not row.get(req_col):
            raise SubmissionValidationError(f"{csv_path} line {line_no}: empty {req_col}")

    label = row.get("label", "").lower()
    if label not in SCORE_LABEL_ALIASES:
        raise SubmissionValidationError(
            f"{csv_path} line {line_no}: invalid label {row.get('label')!r} (expected 맞음 / 아님 / 확인필요)"
        )

    it = _validate_blue_numeric_fields(row, csv_path, line_no)
    if row.get("is_holdout", "").lower() not in VALID_HOLDOUT_VALUES:
        raise SubmissionValidationError(f"{csv_path} line {line_no}: invalid is_holdout {row.get('is_holdout')!r}")

    if has_case_id:
        cid = row.get("case_id", "")
        if not cid or cid in seen_case_ids:
            msg = f"empty case_id" if not cid else f"duplicate case_id {cid!r}"
            raise SubmissionValidationError(f"{csv_path} line {line_no}: {msg}")
        seen_case_ids.add(cid)

    dedup_key = (row["paper_id"], row["team"], str(it), row["location"], row["defect_type"].upper())
    if dedup_key in seen_keys:
        raise SubmissionValidationError(f"{csv_path} line {line_no}: duplicate prediction key {dedup_key}")
    seen_keys.add(dedup_key)


def validate_path(target: pathlib.Path, schema: dict[str, Any] | None = None) -> list[pathlib.Path]:
    """Validate a Red JSON file, Blue CSV file, or directory of submissions."""
    if not target.exists():
        raise SubmissionValidationError(f"Path does not exist: {target}")
    schema = schema or load_schema()
    files = [target] if target.is_file() else sorted(
        p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in {".json", ".csv"}
    )
    if not files:
        raise SubmissionValidationError(f"No .json or .csv submission files found under {target}")

    for fpath in files:
        ext = fpath.suffix.lower()
        if ext == ".json":
            try:
                data = json.loads(fpath.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise SubmissionValidationError(f"{fpath}: invalid JSON ({exc})") from exc
            try:
                validate_red_submission(data, schema=schema, base_dir=fpath.parent)
            except SubmissionValidationError as exc:
                raise SubmissionValidationError(f"{fpath}: {exc}") from exc
        elif ext == ".csv":
            validate_blue_csv(fpath)
        else:
            raise SubmissionValidationError(f"Unsupported submission file extension: {fpath}")
    return files


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Validate Falsify Season 13 Red JSON and Blue CSV submissions")
    ap.add_argument("path", help="Submission file (.json or .csv) or directory")
    ap.add_argument("--schema", default=None, help="Optional custom Red submission schema.json")
    args = ap.parse_args(list(argv) if argv is not None else None)

    try:
        schema = load_schema(pathlib.Path(args.schema) if args.schema else None)
        files = validate_path(pathlib.Path(args.path), schema=schema)
    except SubmissionValidationError as exc:
        print(f"VALIDATION FAILED: {exc}", file=sys.stderr)
        return 1

    print(f"Validated {len(files)} submission file(s) successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
