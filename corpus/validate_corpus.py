"""Validator for Falsify Season 13 Fact Cards (`corpus/schema.json`)."""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
import sys
from typing import Any, Sequence

DEFAULT_SCHEMA_PATH = pathlib.Path(__file__).resolve().parent / "schema.json"
ALLOWED_LICENSES = frozenset({"CC BY", "CC BY 4.0", "CC0"})
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")


class CorpusValidationError(ValueError):
    """Raised when a Fact Card violates schema or license rules."""


def _matches_type(value: Any, kind: str) -> bool:
    checks = {
        "null": value is None,
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
    }
    return checks.get(kind, False)


def _validate_scalar(value: Any, schema: dict[str, Any], path: str) -> None:
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise CorpusValidationError(f"{path}: string length < {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise CorpusValidationError(f"{path}: {value!r} does not match pattern {schema['pattern']!r}")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value):
            raise CorpusValidationError(f"{path}: non-finite number")
        if value < schema.get("minimum", float("-inf")) or value > schema.get("maximum", float("inf")):
            raise CorpusValidationError(f"{path}: number {value} out of range")


def validate_against_schema(
    value: Any,
    schema: dict[str, Any],
    path: str = "$",
    root: dict[str, Any] | None = None,
) -> None:
    """Validate JSON-like data against a subset of JSON Schema Draft 2020-12."""
    root = schema if root is None else root
    if "$ref" in schema:
        target = root
        for part in schema["$ref"].split("/")[1:]:
            target = target[part]
        validate_against_schema(value, target, path, root)
        return

    types = schema.get("type")
    if types is not None:
        allowed = [types] if isinstance(types, str) else list(types)
        if not any(_matches_type(value, k) for k in allowed):
            raise CorpusValidationError(f"{path}: expected type {allowed}, got {type(value).__name__}")

    if "enum" in schema and value not in schema["enum"]:
        raise CorpusValidationError(f"{path}: value {value!r} not in allowed enum {schema['enum']}")

    if isinstance(value, dict):
        _validate_dict(value, schema, path, root)
    elif isinstance(value, list):
        _validate_list(value, schema, path, root)
    else:
        _validate_scalar(value, schema, path)


def _validate_dict(value: dict[str, Any], schema: dict[str, Any], path: str, root: dict[str, Any]) -> None:
    for req in schema.get("required", []):
        if req not in value:
            raise CorpusValidationError(f"{path}: missing required field {req!r}")
    props = schema.get("properties", {})
    if schema.get("additionalProperties") is False:
        extra = set(value) - set(props)
        if extra:
            raise CorpusValidationError(f"{path}: unexpected properties {sorted(extra)}")
    for k, v in value.items():
        if k in props:
            validate_against_schema(v, props[k], f"{path}.{k}", root)


def _validate_list(value: list[Any], schema: dict[str, Any], path: str, root: dict[str, Any]) -> None:
    if len(value) < schema.get("minItems", 0):
        raise CorpusValidationError(f"{path}: expected at least {schema['minItems']} items, got {len(value)}")
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        raise CorpusValidationError(f"{path}: expected at most {schema['maxItems']} items, got {len(value)}")
    item_schema = schema.get("items", {})
    for idx, item in enumerate(value):
        validate_against_schema(item, item_schema, f"{path}[{idx}]", root)


def load_schema(schema_path: pathlib.Path | None = None) -> dict[str, Any]:
    path = schema_path or DEFAULT_SCHEMA_PATH
    return json.loads(path.read_text(encoding="utf-8"))


def validate_fact_card(data: Any, schema: dict[str, Any] | None = None) -> None:
    """Validate a Fact Card dictionary for schema compliance and Season 13 invariants."""
    if not isinstance(data, dict):
        raise CorpusValidationError("Fact card must be a JSON object")

    lic = data.get("license")
    if lic not in ALLOWED_LICENSES:
        raise CorpusValidationError(
            f"$.license: license {lic!r} is forbidden or unsupported; "
            f"only open-adaptation licenses {sorted(ALLOWED_LICENSES)} are allowed"
        )

    validate_against_schema(data, schema or load_schema())

    for t_idx, tbl in enumerate(data.get("tables", [])):
        for r_idx, row in enumerate(tbl.get("rows", [])):
            _check_table_row(row, f"$.tables[{t_idx}].rows[{r_idx}]")

    for c_idx, cit in enumerate(data.get("citations", [])):
        doi = (cit.get("doi") or "").strip()
        if doi and not DOI_RE.match(doi):
            raise CorpusValidationError(f"$.citations[{c_idx}].doi: invalid DOI {doi!r}")

    for a_idx, anc in enumerate(data.get("claim_anchors", [])):
        ci = anc.get("ci")
        if isinstance(ci, list) and len(ci) == 2 and ci[0] > ci[1]:
            raise CorpusValidationError(f"$.claim_anchors[{a_idx}].ci: lower bound {ci[0]} > upper bound {ci[1]}")


def _check_table_row(row: dict[str, Any], path: str) -> None:
    has_numeric = any(k in row for k in ("value", "mean", "percentage", "ci", "ci_low", "p_value", "n"))
    if not has_numeric:
        raise CorpusValidationError(f"{path}: table row must include at least one numeric field")
    ci = row.get("ci")
    if isinstance(ci, list) and len(ci) == 2 and ci[0] > ci[1]:
        raise CorpusValidationError(f"{path}.ci: lower bound {ci[0]} > upper bound {ci[1]}")
    p_val = row.get("p_value")
    if isinstance(p_val, (int, float)) and not (0.0 <= float(p_val) <= 1.0):
        raise CorpusValidationError(f"{path}.p_value: must be in [0, 1], got {p_val}")


def validate_path(target: pathlib.Path, schema: dict[str, Any] | None = None) -> list[pathlib.Path]:
    """Validate a Fact Card JSON file or all JSON files in a directory."""
    schema = schema or load_schema()
    if not target.exists():
        raise CorpusValidationError(f"Path does not exist: {target}")
    files = [target] if target.is_file() else sorted(target.rglob("*.json"))
    if not files:
        raise CorpusValidationError(f"No JSON files found under {target}")
    for fpath in files:
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise CorpusValidationError(f"{fpath}: invalid JSON ({exc})") from exc
        try:
            validate_fact_card(data, schema=schema)
        except CorpusValidationError as exc:
            raise CorpusValidationError(f"{fpath}: {exc}") from exc
    return files


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Validate Falsify Season 13 Fact Card JSON files")
    ap.add_argument("path", help="Fact card JSON file or directory of Fact Card JSON files")
    ap.add_argument("--schema", default=None, help="Optional custom schema.json path")
    args = ap.parse_args(list(argv) if argv is not None else None)

    try:
        schema = load_schema(pathlib.Path(args.schema) if args.schema else None)
        files = validate_path(pathlib.Path(args.path), schema=schema)
    except CorpusValidationError as exc:
        print(f"VALIDATION FAILED: {exc}", file=sys.stderr)
        return 1

    print(f"Validated {len(files)} fact card file(s) successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
