"""SARIF 2.1.0 export and the Falsify JSON Schema catalog.

Paths are reduced to file names. RED answer-key fields are rejected before any
result is built.
"""

SARIF_SCHEMA_URL = "https://json.schemastore.org/sarif-2.1.0.json"
SARIF_VERSION = "2.1.0"
CATALOG_SCHEMA = "falsify.schema-catalog.v1"
_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "goldLedger", "why_hard", "candidateRationales", "plan",
})
_JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema"


def _walk_dict(value):
    for key, item in value.items():
        if key in _FORBIDDEN_RED_KEYS:
            raise ValueError("forbidden_red_key")
        _walk(item)


def _walk(value):
    if isinstance(value, dict):
        _walk_dict(value)
    elif isinstance(value, list):
        for item in value:
            _walk(item)


def _assert_no_red_keys(value):
    if not isinstance(value, dict):
        raise ValueError("sarif_payload_invalid")
    _walk(value)


def _list_at(payload, key):
    if not isinstance(payload, dict):
        return None
    value = payload.get(key)
    if isinstance(value, list):
        return value
    return None


def _nested_list(payload, outer, inner):
    if not isinstance(payload, dict):
        return None
    return _list_at(payload.get(outer), inner)


def _dicts(items):
    return [item for item in items if isinstance(item, dict)]


def _first_dicts(candidates):
    for candidate in candidates:
        if candidate is not None:
            return _dicts(candidate)
    return None


def _items(payload):
    signals = _first_dicts((
        _list_at(payload, "signals"),
        _nested_list(payload, "scan", "signals"),
        _nested_list(payload, "sensor", "signals"),
    ))
    if signals is not None:
        return True, signals
    findings = _first_dicts((
        _list_at(payload, "findings"),
        _nested_list(payload, "report", "findings"),
        _nested_list(payload, "finalReport", "findings"),
    ))
    if findings is not None:
        return False, findings
    return True, []


def _text_at(item, key):
    value = item.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ""


def _first_text(item, keys):
    for key in keys:
        text = _text_at(item, key)
        if text:
            return text
    return ""


def _message_text(item):
    return _first_text(item, ("detail", "rationale", "summary")) or "falsify finding"


def _snippet_text(item):
    return _first_text(item, ("excerpt", "quote"))[:220]


def _page_number(item):
    raw = item.get("pageIndex")
    if type(raw) is not int:
        raw = item.get("page_index", 0)
    if type(raw) is not int:
        return 0
    return raw


def _start_line(item):
    return max(1, _page_number(item) + 1)


def _signal_rule(item):
    kind = item.get("kind")
    if isinstance(kind, str) and kind:
        return kind
    return "falsify.layer0.signal"


def _finding_rule(item):
    family = item.get("family")
    if isinstance(family, str) and family:
        return family
    category = item.get("category")
    if isinstance(category, str) and category:
        return category
    return "falsify.blue.finding"


def _is_error(item):
    return item.get("decision") == "defect" or item.get("verdictLabel") == "아님"


def _is_note(item):
    if item.get("verdictLabel") == "맞음":
        return True
    if item.get("decision") in {"verified_clean", "clean"}:
        return True
    return item.get("verified_clean") is True


def _level(item, is_signal):
    if _is_error(item):
        return "error"
    if _is_note(item):
        return "note"
    if is_signal or item.get("verdictLabel") == "확인필요" or item.get("decision") == "확인필요":
        return "warning"
    return "warning"


def _basename(text):
    return text.replace("\\", "/").rstrip("/").split("/")[-1]


def _usable_name(name):
    if name and name not in {".", ".."} and ":" not in name:
        return name
    return None


def _clean_uri(uri):
    if not isinstance(uri, str):
        return "manuscript.pdf"
    name = _usable_name(_basename(uri.strip()))
    if name is None:
        return "manuscript.pdf"
    return name


def _target_uri(item, default_uri):
    for key in ("supplementName", "supplementFile"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return _clean_uri(value)
    return default_uri


def _properties(item):
    kept = {}
    for key in ("family", "subtype", "verdictLabel", "quoteStatus"):
        text = _text_at(item, key)
        if text:
            kept[key] = text
    return kept


def _location(item, default_uri):
    return {
        "physicalLocation": {
            "artifactLocation": {"uri": _target_uri(item, default_uri)},
            "region": {
                "startLine": _start_line(item),
                "snippet": {"text": _snippet_text(item)},
            },
        }
    }


def _result(item, is_signal, default_uri):
    rule_id = _signal_rule(item) if is_signal else _finding_rule(item)
    result = {
        "ruleId": rule_id,
        "level": _level(item, is_signal),
        "message": {"text": _message_text(item)},
        "locations": [_location(item, default_uri)],
    }
    props = _properties(item)
    if props:
        result["properties"] = props
    return result


def _rules(results):
    rules, seen = [], set()
    for result in results:
        rule_id = result["ruleId"]
        if rule_id in seen:
            continue
        seen.add(rule_id)
        rules.append({"id": rule_id, "shortDescription": {"text": rule_id}})
    return rules


def _driver(tool_version, rules):
    version = tool_version if isinstance(tool_version, str) and tool_version else "0.2.0"
    return {"name": "falsify", "version": version, "rules": rules}


def export_sarif_report(payload, *, artifact_uri="manuscript.pdf", tool_version="0.2.0"):
    """Export sensor signals or BLUE findings as one SARIF 2.1.0 log."""
    _assert_no_red_keys(payload)
    default_uri = _clean_uri(artifact_uri)
    is_signal, items = _items(payload)
    results = [_result(item, is_signal, default_uri) for item in items]
    return {
        "$schema": SARIF_SCHEMA_URL,
        "version": SARIF_VERSION,
        "runs": [{
            "tool": {"driver": _driver(tool_version, _rules(results))},
            "results": results,
        }],
    }


def _prop(kind):
    return {"type": kind}


def _object_schema(required, fields):
    return {
        "$schema": _JSON_SCHEMA,
        "type": "object",
        "additionalProperties": True,
        "required": list(required),
        "properties": {name: _prop(kind) for name, kind in fields},
    }


def _entry(row):
    schema_id, role, summary, producer, required, fields = row
    return {
        "schemaId": schema_id,
        "role": role,
        "summary": summary,
        "cliProducer": producer,
        "jsonSchema": _object_schema(required, fields),
    }


_CATALOG_ROWS = (
    (
        "falsify.agent-cli.v1", "cli",
        "Headless JSON envelope emitted by falsify_cli.py commands.",
        "falsify_cli.py",
        ("schema", "ok"),
        (("schema", "string"), ("ok", "boolean"), ("command", "string")),
    ),
    (
        "falsify.blue-defect-sensor.v1", "blue",
        "Layer 0 BLUE sensor signals for one prepared PDF.",
        "falsify_cli.py blue scan",
        ("schema", "paperId", "fileHash", "signals"),
        (("schema", "string"), ("paperId", "string"), ("fileHash", "string"), ("signals", "array")),
    ),
    (
        "falsify.internal-consistency.v1", "blue",
        "Deterministic IMRaD contradiction signals and advisory triage hints.",
        "falsify_cli.py blue scan --internal-consistency",
        ("schema", "signals"),
        (("schema", "string"), ("signals", "array"), ("triageHints", "array")),
    ),
    (
        "falsify.blue-report.v1", "blue",
        "BLUE findings consumed by validate and emitted by finalize.",
        "falsify_cli.py blue validate",
        ("schema", "findings"),
        (("schema", "string"), ("findings", "array"), ("paperId", "string"), ("fileHash", "string")),
    ),
    (
        "falsify.blue-report-finalize.v1", "blue",
        "One-shot finalize gate result around a cleaned BLUE report.",
        "falsify_cli.py blue finalize",
        ("schema",),
        (("schema", "string"), ("report", "object"), ("csv", "string")),
    ),
    (
        "falsify.quote-repair-pack.v1", "blue",
        "Answer-key-free quote repair pack from blue validate --emit-repair-pack.",
        "falsify_cli.py blue validate --emit-repair-pack",
        ("schema",),
        (("schema", "string"), ("repairs", "array")),
    ),
    (
        "falsify.red-plan.v1", "red",
        "Coordinated RED mutation plan for a target difficulty.",
        "falsify_cli.py red plan",
        ("schema",),
        (("schema", "string"), ("bundles", "array")),
    ),
    (
        "falsify.red-gold-ledger.v1", "red",
        "Sealed RED answer ledger written beside a blind bundle.",
        "falsify_cli.py red apply",
        ("schema", "defects"),
        (("schema", "string"), ("defects", "array")),
    ),
    (
        "falsify.arena-round.v1", "arena",
        "Blind arena round record without cleanroom absolute paths.",
        "falsify_cli.py arena run-round",
        ("schema",),
        (("schema", "string"), ("runs", "array"), ("evaluation", "object")),
    ),
    (
        "falsify.harness-patch.v1", "arena",
        "Scrubbed harness patch distilled from arena failures.",
        "falsify_cli.py arena distill",
        ("schema",),
        (("schema", "string"), ("rules", "array"), ("patchId", "string")),
    ),
    (
        "falsify.evolution-lineage.v1", "arena",
        "Multi-generation RED and BLUE coevolution lineage.",
        "falsify_cli.py arena evolve",
        ("schema",),
        (("schema", "string"), ("generations", "array")),
    ),
    (
        "falsify.benchmark-report.v1", "arena",
        "Arena benchmark report for gold recall and holdout false positives.",
        "falsify_cli.py arena benchmark",
        ("schema",),
        (("schema", "string"), ("cases", "array")),
    ),
    (
        "falsify.mcp-workspace-triage.v1", "cli",
        "Path-free workspace ranking of unmasked PDFs.",
        "falsify_cli.py blue scan-workspace",
        ("schema", "rankedPapers"),
        (("schema", "string"), ("rankedPapers", "array"), ("paperCount", "integer")),
    ),
)


def _catalog_entries():
    return [_entry(row) for row in _CATALOG_ROWS]


def _find_schema(entries, schema_id):
    if not isinstance(schema_id, str):
        return None
    for entry in entries:
        if entry["schemaId"] == schema_id:
            return entry
    return None


def list_falsify_schemas(schema_id=None):
    """Return the schema catalog, or one entry. Unknown ids raise."""
    entries = _catalog_entries()
    if schema_id is None:
        return {"schema": CATALOG_SCHEMA, "count": len(entries), "schemas": entries}
    found = _find_schema(entries, schema_id)
    if found is None:
        raise ValueError("schema_id_unknown")
    return found
