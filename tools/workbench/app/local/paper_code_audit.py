"""Static code-supplement versus manuscript audit. Stdlib only, never executes code."""
import ast
import csv
import io
import re

from paper_tabular_notebook_loader import extract_rmd_qmd_chunks, parse_ipynb_notebook

SCHEMA = "falsify.code-supplement-audit.v1"
_FORBIDDEN = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_CODE_SUFFIXES = frozenset({".py", ".r", ".sql"})
_TABLE_SUFFIXES = frozenset({".csv", ".tsv"})
_TRANSFORMERS = frozenset({
    "StandardScaler", "MinMaxScaler", "RobustScaler", "MaxAbsScaler", "Normalizer",
    "SimpleImputer", "KNNImputer", "IterativeImputer", "PCA", "SelectKBest",
    "TfidfVectorizer", "CountVectorizer",
})
_PARAM_TESTS = frozenset({"ttest_ind", "ttest_rel", "ttest_1samp"})
_RANK_TESTS = frozenset({
    "mannwhitneyu", "wilcoxon", "kruskal", "friedmanchisquare", "ranksums", "brunnermunzel",
})
_TAIL_TESTS = frozenset({
    "ttest_ind", "ttest_rel", "ttest_1samp", "mannwhitneyu", "wilcoxon",
    "fisher_exact", "binomtest", "pearsonr", "spearmanr",
})
_SENT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
_N_RE = re.compile(r"\bN\s*=\s*(\d+)\b", re.IGNORECASE)
_TWO_SIDED_RE = re.compile(r"\b(?:two-sided|two-tailed|2-sided|2-tailed)\b", re.IGNORECASE)
_ONE_SIDED_RE = re.compile(r"\b(?:one-sided|one-tailed|1-sided|1-tailed)\b", re.IGNORECASE)
_LEAK_RE = re.compile(
    r"fit strictly on the training split|fit on training data only|held-out test|held out test|"
    r"train-test partitioning|no data leakage|independent test set|cross-validation|cross validation",
    re.IGNORECASE,
)
_FULL_RE = re.compile(
    r"all enrolled|all randomized|no exclusions|without exclusions|intention-to-treat|intention to treat",
    re.IGNORECASE,
)
_MISSING_RE = re.compile(
    r"complete-case|missing values|missing data|available data",
    re.IGNORECASE,
)
_RANK_CLAIM_RE = re.compile(r"mann[\s-]*whitney|wilcoxon rank[\s-]*sum", re.IGNORECASE)
_MULTI_CLAIM_RE = re.compile(r"bonferroni|benjamini[\s-]*hochberg|\bfdr\b", re.IGNORECASE)
_ADJUST_RE = re.compile(
    r"multipletests|\bp\.adjust\b|p_adjust|bonferroni|benjamini|\bfdr\b|\*\s*n_tests|\bn_tests\s*\*",
    re.IGNORECASE,
)
_RAW_P_RE = re.compile(r"pvalue|p_value|p_val|\bp\s*=", re.IGNORECASE)
_OUTPUT_CLAIM_RE = re.compile(
    r"\b(?P<prefix>train|test|validation|val)?[\s_-]*(?P<name>auc|accuracy|acc|n|p-value|pvalue|p)\b\s*[:=]\s*(?P<value>\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_R_ALT_RE = re.compile(
    r"\b(?:t\.test|wilcox\.test|fisher\.test|cor\.test)\s*\((?P<body>[^)]{0,500})\)",
    re.IGNORECASE,
)
_R_ALT_KW = re.compile(r"alternative\s*=\s*['\"](greater|less)['\"]", re.IGNORECASE)
_R_PARAM_RE = re.compile(r"\bt\.test\s*\(", re.IGNORECASE)
_R_RANK_RE = re.compile(r"\b(?:wilcox\.test|kruskal\.test)\s*\(", re.IGNORECASE)
_R_TEST_RE = re.compile(
    r"\b(?:t\.test|wilcox\.test|kruskal\.test|fisher\.test|cor\.test)\s*\(",
    re.IGNORECASE,
)
_HARD_FILTERS = (
    re.compile(r"\.iloc\s*\[\s*:\s*\d+\s*,?\s*\]"),
    re.compile(r"\.head\s*\(\s*\d+\s*\)"),
    re.compile(r"\bhead\s*\([^)\n]{0,40}\d+"),
    re.compile(r"\w+\[\s*\w+\[[^\]]{1,60}\]\s*!=\s*[^\]\n]{1,40}\]"),
    re.compile(r"~\s*\w+\[[^\]]{0,80}\]\.isin\s*\("),
    re.compile(r"\bsubset\s*\("),
    re.compile(r"\bWHERE\s+[^;\n]{0,160}\bNOT\s+IN\s*\(", re.IGNORECASE),
    re.compile(r"\w+\[\s*\w+\[[^\]]{1,60}\]\s*<\s*[^\]\n]{1,30}\]"),
)
_MISSING_FILTERS = (
    re.compile(r"\.dropna\s*\("),
    re.compile(r"\bna\.omit\s*\("),
    re.compile(r"\bcomplete\.cases\s*\("),
)


def _assert_no_red(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _FORBIDDEN:
                raise ValueError("forbidden_red_key")
            _assert_no_red(item)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _assert_no_red(item)


def _validate_limit(max_signals):
    if type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError("limit")


def _empty():
    return {
        "schema": SCHEMA,
        "status": "no_code_supplement",
        "scriptCount": 0,
        "signalCount": 0,
        "truncated": False,
        "signals": [],
    }


def _page_index(value, fallback):
    if type(value) is int:
        return value
    return fallback


def _page(page_id, page_index, text):
    ident = page_id if isinstance(page_id, str) and page_id else f"p{page_index}"
    return {"id": ident, "pageIndex": page_index, "text": text}


def _page_record(item, idx):
    if isinstance(item, str):
        return [_page(None, idx, item)]
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        return [_page(None, _page_index(item[0], idx), str(item[1]))]
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        page = _page_index(item.get("pageIndex", idx), idx)
        return [_page(item.get("id", f"p{idx}"), page, item["text"])]
    return []


def _normalize_pages(page_items):
    if isinstance(page_items, str):
        page_items = [page_items]
    pages = []
    for idx, item in enumerate(page_items or []):
        pages.extend(_page_record(item, idx))
    return pages


def _sentences(text):
    parts = []
    for part in _SENT_RE.split(text or ""):
        cleaned = part.strip()
        if cleaned:
            parts.append(cleaned)
    return parts


def _claims_from(pages):
    claims = []
    for page in pages:
        for sentence in _sentences(page["text"]):
            claims.append({"pageIndex": page["pageIndex"], "id": page["id"], "text": sentence})
    return claims


def _supp_name(supp):
    for key in ("name", "fileName", "filename"):
        value = supp.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "supplement"


def _segment_text(segments):
    chunks = []
    for segment in segments:
        if isinstance(segment, dict) and isinstance(segment.get("text"), str):
            chunks.append(segment["text"])
    return "\n".join(chunks)


def _supp_text(supp):
    if isinstance(supp.get("text"), str):
        return supp["text"]
    if isinstance(supp.get("bytes"), (bytes, bytearray)):
        return bytes(supp["bytes"]).decode("utf-8", errors="replace")
    return _segment_text(supp.get("segments") or [])


def _suffix(name):
    match = re.search(r"(\.[A-Za-z0-9]+)$", str(name or ""))
    if match is None:
        return ""
    return match.group(1).lower()


def _table_row_count(text, suffix):
    delimiter = "\t" if suffix == ".tsv" else ","
    try:
        rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff")), delimiter=delimiter))
    except csv.Error:
        return None
    kept = [row for row in rows if any(str(cell).strip() for cell in row)]
    if len(kept) <= 1:
        return 0
    return len(kept) - 1


def _add_count(counts, count):
    if isinstance(count, int) and count > 0:
        counts.add(count)


def _take_supplement(supp, scripts, counts):
    name = _supp_name(supp)
    suffix = _suffix(name)
    text = _supp_text(supp)
    if suffix in _TABLE_SUFFIXES:
        _add_count(counts, _table_row_count(text, suffix))
        return
    if suffix in _CODE_SUFFIXES:
        scripts.append({"name": name, "text": text, "suffix": suffix})
        return
    _take_extra(supp, scripts, name, suffix)


def _partition_supplements(supplements):
    scripts, counts = [], set()
    for supp in supplements or []:
        if isinstance(supp, dict):
            _take_supplement(supp, scripts, counts)
    return scripts, counts


def _parse_py(text):
    try:
        return ast.parse(text)
    except SyntaxError:
        return None


def _call_name(func):
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _keyword_str(call, name):
    for kw in call.keywords:
        if kw.arg != name or not isinstance(kw.value, ast.Constant):
            continue
        if isinstance(kw.value.value, str):
            return kw.value.value.lower()
    return None


def _assign_pair(stmt):
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        return stmt.targets[0].id, stmt.value
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
        return stmt.target.id, stmt.value
    return None, None


def _skip_nested(node):
    return isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef))


def _collect_calls(node, calls):
    if _skip_nested(node):
        return
    if isinstance(node, ast.Call):
        calls.append(node)
    for child in ast.iter_child_nodes(node):
        _collect_calls(child, calls)


def _call_sort_key(node):
    return (getattr(node, "lineno", 0), getattr(node, "col_offset", 0))


def _calls_of(stmts):
    calls = []
    for stmt in stmts:
        _collect_calls(stmt, calls)
    calls.sort(key=_call_sort_key)
    return calls


def _collect_assigns(node, found):
    if _skip_nested(node):
        return
    target, value = _assign_pair(node)
    if target and isinstance(value, ast.Call) and _call_name(value.func) in _TRANSFORMERS:
        found[target] = _call_name(value.func)
    for child in ast.iter_child_nodes(node):
        _collect_assigns(child, found)


def _transformer_names(stmts):
    found = {}
    for stmt in stmts:
        _collect_assigns(stmt, found)
    return found


def _scope_bodies(node):
    bodies = []
    if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)):
        bodies.append(node.body)
    children = node.body if hasattr(node, "body") else []
    for child in children:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bodies.extend(_scope_bodies(child))
    return bodies


def _named_lineno(calls, name):
    for call in calls:
        if _call_name(call.func) == name:
            return call.lineno
    return None


def _is_transformer_value(node, assigned):
    if isinstance(node, ast.Call):
        return _call_name(node.func) in _TRANSFORMERS
    if isinstance(node, ast.Name):
        return assigned.get(node.id) in _TRANSFORMERS
    return False


def _transformer_fit(call, assigned):
    func = call.func
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr not in {"fit", "fit_transform"}:
        return False
    return _is_transformer_value(func.value, assigned)


def _leak_lines(calls, assigned):
    split_at = _named_lineno(calls, "train_test_split")
    if split_at is None:
        return []
    lines, seen = [], set()
    for call in calls:
        if not _transformer_fit(call, assigned):
            continue
        if call.lineno >= split_at or call.lineno in seen:
            continue
        seen.add(call.lineno)
        lines.append(call.lineno)
    return lines


def _tail_hits(calls):
    hits = []
    for call in calls:
        if _call_name(call.func) not in _TAIL_TESTS:
            continue
        alt = _keyword_str(call, "alternative")
        if alt in {"greater", "less"}:
            hits.append((call.lineno, alt))
    return hits


def _count_calls(calls, names):
    total, first = 0, None
    for call in calls:
        if _call_name(call.func) not in names:
            continue
        total += 1
        if first is None:
            first = call.lineno
    return total, first


def _scope_facts(stmts):
    calls = _calls_of(stmts)
    assigned = _transformer_names(stmts)
    param, param_line = _count_calls(calls, _PARAM_TESTS)
    rank, _rank_line = _count_calls(calls, _RANK_TESTS)
    tests, test_line = _count_calls(calls, _TAIL_TESTS)
    return {
        "tail": _tail_hits(calls),
        "leaks": _leak_lines(calls, assigned),
        "param": param,
        "rank": rank,
        "tests": tests,
        "param_line": param_line,
        "test_line": test_line,
    }


def _text_flags(text):
    return {
        "tail": [],
        "leaks": [],
        "param": 0,
        "rank": 0,
        "tests": 0,
        "adjusted": _ADJUST_RE.search(text) is not None,
        "raw_p": _RAW_P_RE.search(text) is not None,
        "param_line": None,
        "test_line": None,
    }


def _merge_scope(base, part):
    base["tail"].extend(part["tail"])
    base["leaks"].extend(part["leaks"])
    base["param"] += part["param"]
    base["rank"] += part["rank"]
    base["tests"] += part["tests"]
    if base["param_line"] is None:
        base["param_line"] = part["param_line"]
    if base["test_line"] is None:
        base["test_line"] = part["test_line"]


def _py_facts(text):
    base = _text_flags(text)
    tree = _parse_py(text)
    if tree is None:
        return base
    for stmts in _scope_bodies(tree):
        _merge_scope(base, _scope_facts(stmts))
    return base


def _line_no(text, start):
    return text.count("\n", 0, start) + 1


def _first_pattern_line(text, pattern):
    match = pattern.search(text)
    if match is None:
        return None
    return _line_no(text, match.start())


def _r_tail(text):
    hits = []
    for match in _R_ALT_RE.finditer(text):
        alt = _R_ALT_KW.search(match.group("body") or "")
        if alt is None:
            continue
        hits.append((_line_no(text, match.start()), alt.group(1).lower()))
    return hits


def _r_facts(text):
    base = _text_flags(text)
    base["tail"] = _r_tail(text)
    base["param"] = len(_R_PARAM_RE.findall(text))
    base["rank"] = len(_R_RANK_RE.findall(text))
    base["tests"] = len(_R_TEST_RE.findall(text))
    base["param_line"] = _first_pattern_line(text, _R_PARAM_RE)
    base["test_line"] = _first_pattern_line(text, _R_TEST_RE)
    return base


def _facts_for(script):
    if script["suffix"] == ".py":
        return _py_facts(script["text"])
    if script["suffix"] == ".r":
        return _r_facts(script["text"])
    return _text_flags(script["text"])


def _line_text(text, lineno):
    lines = text.splitlines()
    if lineno < 1 or lineno > len(lines):
        return ""
    return lines[lineno - 1].strip()[:180]


def _signal(kind, subtype, claim, script, lineno, detail, extra):
    snippet = _line_text(script["text"], lineno)
    excerpt = " ".join(claim["text"].split())[:220]
    computed = {"supplementName": script["name"], "lineNumber": lineno, "codeSnippet": snippet}
    computed.update(extra)
    return {
        "kind": kind,
        "family": "D6",
        "subtype": subtype,
        "pageIndex": claim["pageIndex"],
        "segmentId": claim.get("id"),
        "excerpt": excerpt,
        "supplementName": script["name"],
        "lineNumber": lineno,
        "codeSnippet": snippet,
        "detail": detail,
        "computed": computed,
    }


def _claims_match(claims, pattern):
    for claim in claims:
        if pattern.search(claim["text"]):
            return claim
    return None


def _window_direction(text, start, end):
    window = text[max(0, start - 80):end + 80]
    greater = re.search(r"\bgreater\b", window, re.IGNORECASE) is not None
    less = re.search(r"\bless\b", window, re.IGNORECASE) is not None
    if greater and not less:
        return "greater"
    if less and not greater:
        return "less"
    return None


def _manuscript_direction(text):
    if _TWO_SIDED_RE.search(text):
        return "two"
    match = _ONE_SIDED_RE.search(text)
    if match is None:
        return None
    return _window_direction(text, match.start(), match.end())


def _directions_conflict(manuscript, code_dir):
    if manuscript == "two":
        return code_dir in {"greater", "less"}
    if manuscript == "greater":
        return code_dir == "less"
    if manuscript == "less":
        return code_dir == "greater"
    return False


def _direction_claim(claims, code_dir):
    for claim in claims:
        if _directions_conflict(_manuscript_direction(claim["text"]), code_dir):
            return claim
    return None


def _tail_signals(claims, script, facts):
    signals = []
    for lineno, direction in facts["tail"]:
        claim = _direction_claim(claims, direction)
        if claim is None:
            continue
        signals.append(_signal(
            "code_tailness_mismatch",
            "code-tailness-mismatch",
            claim,
            script,
            lineno,
            "Code alternative direction contradicts the manuscript tail claim.",
            {"alternative": direction},
        ))
    return signals


def _leak_signals(claims, script, facts):
    if script["suffix"] != ".py" or not facts["leaks"]:
        return []
    claim = _claims_match(claims, _LEAK_RE)
    if claim is None:
        return []
    signals = []
    for lineno in facts["leaks"]:
        signals.append(_signal(
            "code_preprocessing_leakage",
            "code-data-leakage",
            claim,
            script,
            lineno,
            "Stateful preprocessor is fit before train_test_split despite an isolated-split claim.",
            {"call": "fit"},
        ))
    return signals


def _n_matches_csv(text, csv_counts):
    if not csv_counts:
        return False
    for match in _N_RE.finditer(text):
        if int(match.group(1)) in csv_counts:
            return True
    return False


def _cohort_claim_for(claims, csv_counts):
    for claim in claims:
        if _FULL_RE.search(claim["text"]) or _n_matches_csv(claim["text"], csv_counts):
            return claim
    return None


def _tagged_hits(text, patterns, kind):
    hits = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            hits.append((_line_no(text, match.start()), kind))
    return hits


def _unique_lines(hits):
    seen, unique = set(), []
    for lineno, kind in hits:
        key = (lineno, kind)
        if key in seen:
            continue
        seen.add(key)
        unique.append((lineno, kind))
    return unique


def _row_hits(text):
    hits = _tagged_hits(text, _HARD_FILTERS, "hard")
    hits.extend(_tagged_hits(text, _MISSING_FILTERS, "missing"))
    return _unique_lines(hits)


def _comment_line(script, lineno):
    line = _line_text(script["text"], lineno).lstrip()
    if script["suffix"] == ".sql":
        return line.startswith("--")
    return line.startswith("#")


def _skip_filter(script, lineno, kind, allow_missing):
    if kind == "missing" and allow_missing:
        return True
    return _comment_line(script, lineno)


def _filter_signals(claims, script, csv_counts):
    claim = _cohort_claim_for(claims, csv_counts)
    if claim is None:
        return []
    allow_missing = _claims_match(claims, _MISSING_RE) is not None
    signals = []
    for lineno, kind in _row_hits(script["text"]):
        if _skip_filter(script, lineno, kind, allow_missing):
            continue
        signals.append(_signal(
            "code_undisclosed_row_filter",
            "code-undisclosed-exclusion",
            claim,
            script,
            lineno,
            "Hardcoded row filter contradicts a full-cohort or raw-N claim.",
            {"filter": kind},
        ))
    return signals


def _nonparam_conflict(facts):
    return facts["param"] > 0 and facts["rank"] == 0


def _multiplicity_conflict(facts):
    return facts["tests"] >= 2 and not facts["adjusted"]


def _method_line(facts):
    if facts["param_line"] is not None:
        return facts["param_line"]
    if facts["test_line"] is not None:
        return facts["test_line"]
    return 1


def _method_signal(claim, script, facts, detail):
    return _signal(
        "code_test_method_mismatch",
        "code-method-mismatch",
        claim,
        script,
        _method_line(facts),
        detail,
        {},
    )


def _method_signals(claims, script, facts):
    signals = []
    rank_claim = _claims_match(claims, _RANK_CLAIM_RE)
    if rank_claim is not None and _nonparam_conflict(facts):
        signals.append(_method_signal(
            rank_claim, script, facts,
            "Parametric t test contradicts the claimed rank-based primary test.",
        ))
    multi_claim = _claims_match(claims, _MULTI_CLAIM_RE)
    if multi_claim is not None and _multiplicity_conflict(facts):
        signals.append(_method_signal(
            multi_claim, script, facts,
            "Multiple raw tests contradict the claimed multiplicity correction.",
        ))
    return signals


def _script_signals(claims, script, facts, csv_counts):
    return (
        _tail_signals(claims, script, facts)
        + _leak_signals(claims, script, facts)
        + _filter_signals(claims, script, csv_counts)
    )


def _collect(claims, scripts, csv_counts):
    prepared = [(script, _facts_for(script)) for script in scripts]
    signals = []
    for script, facts in prepared:
        signals.extend(_script_signals(claims, script, facts, csv_counts))
    if len(prepared) == 1:
        script, facts = prepared[0]
        signals.extend(_method_signals(claims, script, facts))
    return _remap_lines(_dedupe(signals), scripts)


def _dedupe(signals):
    seen, unique = set(), []
    for signal in signals:
        key = (signal["kind"], signal["supplementName"], signal["lineNumber"], signal["excerpt"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(signal)
    return unique


def _number(signals, max_signals):
    numbered = []
    for index, signal in enumerate(signals[:max_signals], start=1):
        numbered.append({"id": f"code-{index}", **signal})
    return numbered, len(signals) > max_signals


def _parsed_notebook(supp):
    stored = supp.get("notebook")
    if isinstance(stored, dict) and "combinedCode" in stored:
        return stored
    name = _supp_name(supp)
    raw = supp.get("bytes")
    if isinstance(raw, (bytes, bytearray)) and _suffix(name) == ".ipynb":
        return parse_ipynb_notebook(bytes(raw), name=name)
    text = supp.get("text")
    if isinstance(text, str) and text.lstrip().startswith("{"):
        return parse_ipynb_notebook(text, name=name)
    return None


def _append_notebook(supp, scripts, name):
    parsed = _parsed_notebook(supp)
    if parsed is None:
        return
    language = parsed.get("language") or "python"
    text = parsed.get("combinedCode") or ""
    if not str(text).strip():
        return
    scripts.append({
        "name": name,
        "text": text,
        "suffix": ".r" if language == "r" else ".py",
        "lineOffsets": parsed.get("lineOffsets") or [],
        "outputLines": parsed.get("outputLines") or [],
    })


def _padded_chunks(chunks, language):
    lines = []
    for chunk in chunks:
        if chunk.get("language") != language:
            continue
        start = chunk.get("startLine") or 1
        while len(lines) < start - 1:
            lines.append("")
        lines.extend(str(chunk.get("code") or "").splitlines())
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def _append_literate(supp, scripts, name):
    chunks = extract_rmd_qmd_chunks(_supp_text(supp), name=name)
    for language, suffix in (("python", ".py"), ("r", ".r")):
        text = _padded_chunks(chunks, language)
        if text.strip():
            scripts.append({"name": name, "text": text, "suffix": suffix})


def _take_extra(supp, scripts, name, suffix):
    if suffix == ".ipynb":
        _append_notebook(supp, scripts, name)
        return
    if suffix in {".rmd", ".qmd"}:
        _append_literate(supp, scripts, name)


def _offset_lookup(scripts):
    found = {}
    for script in scripts:
        offsets = script.get("lineOffsets")
        if offsets:
            found[script["name"]] = offsets
    return found


def _apply_line_offset(signal, offsets):
    if not offsets:
        return
    lineno = signal.get("lineNumber")
    if type(lineno) is not int or lineno < 1 or lineno > len(offsets):
        return
    info = offsets[lineno - 1]
    cell_line = info.get("cellLine") or lineno
    signal["lineNumber"] = cell_line
    computed = signal.get("computed")
    if isinstance(computed, dict):
        computed["lineNumber"] = cell_line
        computed["cellIndex"] = info.get("cellIndex")


def _remap_lines(signals, scripts):
    lookup = _offset_lookup(scripts)
    for signal in signals:
        _apply_line_offset(signal, lookup.get(signal.get("supplementName")))
    return signals


def _metric_tol(token):
    decimals = len(token.split(".", 1)[1]) if "." in str(token) else 0
    return max(1e-6, 0.5 * (10 ** (-decimals))) + 1e-9


def _metric_label(match):
    prefix = (match.group("prefix") or "").lower()
    if prefix == "val":
        prefix = "validation"
    name = match.group("name").lower().replace("-", "")
    if name in {"pvalue", "p"}:
        name = "p"
    if name == "acc":
        name = "accuracy"
    if prefix:
        return f"{prefix} {name}"
    return name


def _labeled_metrics(text):
    found = []
    for line_no, line in enumerate(str(text or "").splitlines(), start=1):
        for match in _OUTPUT_CLAIM_RE.finditer(line):
            found.append({
                "label": _metric_label(match),
                "value": float(match.group("value")),
                "token": match.group("value"),
                "line": line_no,
                "snippet": line.strip()[:180],
            })
    return found


def _claims_metrics(claims):
    found = []
    for claim in claims:
        for item in _labeled_metrics(claim["text"]):
            item["claim"] = claim
            found.append(item)
    return found


def _metric_far(left, right):
    tolerance = max(_metric_tol(left["token"]), _metric_tol(right["token"]))
    return abs(left["value"] - right["value"]) > tolerance


def _same_label_conflict(output_item, manuscript_items):
    same = [item for item in manuscript_items if item["label"] == output_item["label"]]
    if not same:
        return None
    if any(not _metric_far(output_item, item) for item in same):
        return None
    return same[0]


def _output_signal(manuscript, output_item, name):
    claim = manuscript["claim"]
    return {
        "kind": "notebook_output_claim_mismatch",
        "family": "D6",
        "subtype": "ipynb-output-mismatch",
        "pageIndex": claim["pageIndex"],
        "segmentId": claim.get("id"),
        "excerpt": " ".join(claim["text"].split())[:220],
        "supplementName": name,
        "lineNumber": output_item["line"],
        "codeSnippet": output_item["snippet"],
        "detail": "Saved notebook output contradicts the same named manuscript metric.",
        "reported": {"label": manuscript["label"], "value": manuscript["value"]},
        "computed": {
            "label": output_item["label"],
            "value": output_item["value"],
            "supplementName": name,
            "output": output_item["snippet"],
        },
    }


def _output_conflicts(manuscript, parsed, name):
    signals = []
    for item in _labeled_metrics("\n".join(parsed.get("outputLines") or [])):
        match = _same_label_conflict(item, manuscript)
        if match is None:
            continue
        signals.append(_output_signal(match, item, name))
    return signals


def _notebook_output_signals(claims, supplements):
    manuscript = _claims_metrics(claims)
    signals = []
    for supp in supplements or []:
        if not isinstance(supp, dict) or _suffix(_supp_name(supp)) != ".ipynb":
            continue
        parsed = _parsed_notebook(supp)
        if parsed is None:
            continue
        signals.extend(_output_conflicts(manuscript, parsed, _supp_name(supp)))
    return signals


def _all_script_signals(claims, scripts, csv_counts, supplements):
    signals = _collect(claims, scripts, csv_counts)
    signals.extend(_notebook_output_signals(claims, supplements))
    return _dedupe(signals)


def audit_code_supplements(page_items, supplements, *, max_signals=30):
    """Compare static analysis scripts with manuscript claims. Never executes code."""
    _validate_limit(max_signals)
    _assert_no_red(page_items)
    _assert_no_red(supplements)
    scripts, csv_counts = _partition_supplements(supplements)
    if not scripts:
        return _empty()
    claims = _claims_from(_normalize_pages(page_items))
    signals = _all_script_signals(claims, scripts, csv_counts, supplements)
    numbered, truncated = _number(signals, max_signals)
    return {
        "schema": SCHEMA,
        "status": "ok",
        "scriptCount": len(scripts),
        "signalCount": len(numbered),
        "truncated": truncated,
        "signals": numbered,
    }
