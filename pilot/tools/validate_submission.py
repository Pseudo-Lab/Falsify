"""Validate a submission's structure and claim coverage, without access to answers."""
from pathlib import Path
import argparse
import json
import math
import re

def validate(value, schema, path="$", document=None):
    document = schema if document is None else document
    if "$ref" in schema:
        target = document
        for key in schema["$ref"].split("/")[1:]:
            target = target[key]
        return validate(value, target, path, document)
    types = schema.get("type")
    types = [types] if isinstance(types, str) else types
    matches = {"null": value is None, "object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
               "boolean": isinstance(value, bool), "integer": isinstance(value, int) and not isinstance(value, bool),
               "number": isinstance(value, (int, float)) and not isinstance(value, bool)}
    if types and not any(matches.get(kind, False) for kind in types):
        raise ValueError(f"{path}: expected {types}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: value outside enumeration")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value: raise ValueError(f"{path}: missing {key}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = set(value) - set(properties)
            if extra: raise ValueError(f"{path}: unknown properties {sorted(extra)}")
        for key, item in value.items():
            if key in properties: validate(item, properties[key], f"{path}.{key}", document)
    elif isinstance(value, list):
        if len(value) < schema.get("minItems", 0): raise ValueError(f"{path}: too few items")
        for i, item in enumerate(value): validate(item, schema.get("items", {}), f"{path}[{i}]", document)
    elif isinstance(value, str):
        if len(value) < schema.get("minLength", 0): raise ValueError(f"{path}: string too short")
        if "pattern" in schema and not re.search(schema["pattern"], value): raise ValueError(f"{path}: invalid pattern")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value): raise ValueError(f"{path}: non-finite number")
        if value < schema.get("minimum", float("-inf")) or value > schema.get("maximum", float("inf")):
            raise ValueError(f"{path}: numeric value outside range")

def validate_submission(data, schema, index):
    validate(data, schema)
    expected = {item["claim_id"] for item in index["claims"]}
    found = [item["claim_id"] for item in data["findings"]]
    if len(found) != len(set(found)) or set(found) != expected:
        raise ValueError("claim IDs must cover the index exactly once")
    for item in data["findings"]:
        if item["decision"] == "hold" and (not item["unknown_reason"] or not item["needed_evidence"]):
            raise ValueError("hold requires unknown_reason and needed_evidence")
        for check in item["checks"]:
            if not check["executed"] and check["observed"] is not None: raise ValueError("planned checks cannot claim an observed result")
        span = item["error_span"]
        if span and span["end_line"] < span["start_line"]: raise ValueError("reversed error span")
        for ev in item["evidence"]:
            if ev["end_line"] < ev["start_line"]: raise ValueError("reversed evidence range")
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("submission")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    data = json.loads(Path(args.submission).read_text(encoding="utf-8"))
    schema = json.loads((root / "schemas/submission.schema.json").read_text(encoding="utf-8"))
    index = json.loads((root / "paper/claim_index.json").read_text(encoding="utf-8"))
    validate_submission(data, schema, index)
    print("Submission structure and claim coverage are valid; scientific content has not been graded.")

if __name__ == "__main__": main()
