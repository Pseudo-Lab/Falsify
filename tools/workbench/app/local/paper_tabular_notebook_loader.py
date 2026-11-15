"""Static xlsx, ipynb, and Rmd/qmd readers. Never executes workbooks, cells, or macros."""
import io
import json
import math
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_XML_BYTES = 25 * 1024 * 1024
MAX_SHEETS = 32
MAX_CELLS = 100_000
FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_SUM_LABELS = frozenset({"total", "sum"})
_MEAN_LABELS = frozenset({"mean", "average"})
_R_LANGUAGES = frozenset({"r", "ir", "rscript"})
_CELL_REF = r"\$?[A-Z]{1,3}\$?\d+"
_RANGE_RE = re.compile(
    rf"^(?:(?:'(?P<quoted>[^']+)'|(?P<bare>[A-Za-z][A-Za-z0-9_]*))!)?(?P<start>{_CELL_REF})(?::(?P<end>{_CELL_REF}))?$",
    re.IGNORECASE,
)
_FUNC_RE = re.compile(r"^(SUM|AVERAGE|MEAN|MIN|MAX|COUNT)\((.*)\)$", re.IGNORECASE)
_BIN_RE = re.compile(
    rf"^\(?\s*(?P<a>{_CELL_REF})\s*(?P<op>[+\-*/])\s*(?P<b>{_CELL_REF})\s*\)?(?:\s*\*\s*(?P<scale>\d+(?:\.\d+)?))?$",
    re.IGNORECASE,
)
_REF_RE = re.compile(r"^([A-Z]{1,3})(\d+)$")
_CHUNK_RE = re.compile(
    r"^[ \t]*```\{(?P<lang>r|python)\b[^}\n]*\}[ \t]*\r?\n(?P<body>.*?)(?:\r?\n)?^[ \t]*```[ \t]*$",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)


def _assert_no_red_keys(value):
    if isinstance(value, dict):
        _reject_red_dict(value)
        return
    if isinstance(value, list):
        for item in value:
            _assert_no_red_keys(item)


def _reject_red_dict(value):
    for key, item in value.items():
        if key in FORBIDDEN_RED_KEYS:
            raise ValueError("forbidden_red_key")
        _assert_no_red_keys(item)


def _invalid(message="paper_evidence_supplement_invalid"):
    raise ValueError(message)


def _local(tag):
    if not tag or "}" not in tag:
        return tag or ""
    return tag.rsplit("}", 1)[-1]


def _attr(node, name):
    for key, value in node.attrib.items():
        if _local(key) == name:
            return value
    return None


def _reject_doctype(text):
    upper = text.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        _invalid()


def _named_red(name, value):
    return name in {"name", "key"} and value in FORBIDDEN_RED_KEYS


def _reject_red_attrs(node):
    for key, value in node.attrib.items():
        local = _local(key)
        if local in FORBIDDEN_RED_KEYS or _named_red(local, value):
            raise ValueError("forbidden_red_key")


def _reject_red_tree(root):
    for node in root.iter():
        if _local(node.tag) in FORBIDDEN_RED_KEYS:
            raise ValueError("forbidden_red_key")
        _reject_red_attrs(node)


def _xml_root(text):
    _reject_doctype(text)
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        _invalid()
    _reject_red_tree(root)
    return root


def _norm_zip_name(name):
    clean = str(name or "").replace("\\", "/").lstrip("/")
    if ".." in clean.split("/"):
        _invalid()
    return clean.lower()


def _is_xml_name(name):
    return name.endswith(".xml") or name.endswith(".rels")


def _zip_read(zf, info, remaining):
    try:
        with zf.open(info, "r") as handle:
            return handle.read(remaining + 1)
    except (zipfile.BadZipFile, OSError, RuntimeError, EOFError):
        _invalid()


def _read_xml_member(zf, info, remaining):
    if info.file_size > remaining:
        _invalid()
    data = _zip_read(zf, info, remaining)
    if len(data) > remaining:
        _invalid()
    return data


def _consume_xml(zf):
    remaining = MAX_XML_BYTES
    files = {}
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = _norm_zip_name(info.filename)
        if not _is_xml_name(name):
            continue
        data = _read_xml_member(zf, info, remaining)
        remaining -= len(data)
        text = data.decode("utf-8-sig", errors="replace")
        _xml_root(text)
        files[name] = text
    return files


def _load_xlsx_files(raw):
    if len(raw) <= 0 or len(raw) > MAX_ARCHIVE_BYTES:
        _invalid()
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        _invalid()
    with archive:
        return _consume_xml(archive)


def _child_text(node, name):
    for child in list(node):
        if _local(child.tag) == name:
            return child.text or ""
    return None


def _si_text(node):
    parts = []
    for child in list(node):
        local = _local(child.tag)
        if local == "t" and child.text:
            parts.append(child.text)
        elif local == "r":
            parts.append(_si_text(child))
    return "".join(parts)


def _shared_strings(text):
    if not text:
        return []
    root = _xml_root(text)
    return [_si_text(node) for node in list(root) if _local(node.tag) == "si"]


def _shared_at(shared, cached):
    if not cached or not str(cached).isdigit():
        return ""
    index = int(cached)
    if index < 0 or index >= len(shared):
        return ""
    return shared[index]


def _inline_text(node):
    for child in list(node):
        if _local(child.tag) == "is":
            return _si_text(child)
    return ""


def _cell_value(node, shared):
    kind = (_attr(node, "t") or "").strip()
    formula = _child_text(node, "f")
    cached = _child_text(node, "v")
    if kind == "inlineStr":
        return _inline_text(node), formula, cached
    if kind == "s":
        return _shared_at(shared, cached), formula, cached
    if kind == "b":
        shown = "TRUE" if cached == "1" else "FALSE"
        return shown, formula, cached
    return cached or "", formula, cached


def _norm_ref(ref):
    return str(ref or "").replace("$", "").upper()


def _split_ref(ref):
    match = _REF_RE.match(_norm_ref(ref))
    if match is None:
        return None
    return int(match.group(2)), _col_index(match.group(1))


def _col_index(letters):
    value = 0
    for char in letters:
        value = value * 26 + (ord(char) - 64)
    return value - 1


def _ref(col, row):
    index = col + 1
    letters = []
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters.append(chr(65 + rem))
    return "".join(reversed(letters)) + str(row)


def _clean_formula(formula):
    text = " ".join(str(formula or "").replace("\n", " ").split())
    if text.startswith("="):
        return text[1:].strip()
    return text


def _charge_cell(counter):
    counter[0] += 1
    if counter[0] > MAX_CELLS:
        _invalid()


def _formula_cell(ref, row, col0, formula, cached):
    return {
        "ref": ref,
        "row": row,
        "col": col0 + 1,
        "formula": formula,
        "cachedValue": "" if cached is None else str(cached),
    }


def _pack_cell(ref, parts, text, formula, cached):
    row, col0 = parts
    item = {"ref": ref, "row": row, "col0": col0, "text": text or "", "formula": None}
    cleaned = _clean_formula(formula or "")
    if not cleaned:
        return item
    item["formula"] = cleaned
    item["formulaCell"] = _formula_cell(ref, row, col0, cleaned, cached)
    return item


def _one_cell(node, shared, counter):
    parts = _split_ref(_attr(node, "r") or "")
    if parts is None:
        return None
    _charge_cell(counter)
    text, formula, cached = _cell_value(node, shared)
    return _pack_cell(_norm_ref(_attr(node, "r")), parts, text, formula, cached)


def _worksheet_cells(root, shared, counter):
    cells = []
    for node in root.iter():
        if _local(node.tag) != "c":
            continue
        cell = _one_cell(node, shared, counter)
        if cell is not None:
            cells.append(cell)
    return cells


def _pad_row(cells, width):
    return [cells.get(col, "") for col in range(width + 1)]


def _matrix(by_row, width):
    ordered = [by_row[key] for key in sorted(by_row)]
    return [_pad_row(row, width) for row in ordered]


def _grid_from_cells(cells):
    by_row, formulas, values = {}, [], {}
    width = 0
    for item in cells:
        by_row.setdefault(item["row"], {})[item["col0"]] = item["text"]
        values[item["ref"]] = item["text"]
        width = max(width, item["col0"])
        if item.get("formulaCell"):
            formulas.append(item["formulaCell"])
    matrix = _matrix(by_row, width) if by_row else []
    body = matrix[1:] if len(matrix) > 1 else []
    tsv = "\n".join("\t".join(row) for row in matrix)
    headers = matrix[0] if matrix else []
    return {"headers": headers, "rows": body, "tsv": tsv, "formulas": formulas, "values": values}


def _build_sheet(sheet_name, text, shared, counter):
    grid = _grid_from_cells(_worksheet_cells(_xml_root(text), shared, counter))
    return {
        "sheetName": sheet_name,
        "headers": grid["headers"],
        "rows": grid["rows"],
        "tsvText": grid["tsv"],
        "formulaCells": grid["formulas"],
        "values": grid["values"],
    }


def _target_path(target):
    if not target:
        return None
    clean = target.replace("\\", "/").lstrip("/")
    if clean.lower().startswith("xl/"):
        return clean.lower()
    return "xl/" + clean.lstrip("./").lower()


def _rels(text):
    mapping = {}
    if not text:
        return mapping
    for node in _xml_root(text).iter():
        if _local(node.tag) != "Relationship":
            continue
        if "worksheet" not in (_attr(node, "Type") or "").lower():
            continue
        ident = _attr(node, "Id")
        target = _attr(node, "Target")
        if ident and target:
            mapping[ident] = target
    return mapping


def _fallback_names(files):
    found = []
    for name in files:
        match = re.fullmatch(r"xl/worksheets/sheet(\d+)\.xml", name)
        if match:
            found.append((int(match.group(1)), name))
    found.sort()
    if len(found) > MAX_SHEETS:
        _invalid()
    return [(f"Sheet{number}", path) for number, path in found]


def _sheet_from_node(node, rels, files, index):
    name = node.attrib.get("name") or f"Sheet{index}"
    target = rels.get(_attr(node, "id") or "")
    path = _target_path(target)
    if path not in files:
        path = f"xl/worksheets/sheet{index}.xml"
    if path not in files:
        return None
    return name, path


def _listed_sheets(files):
    workbook = files.get("xl/workbook.xml")
    if workbook is None:
        return []
    rels = _rels(files.get("xl/_rels/workbook.xml.rels"))
    specs = []
    for node in _xml_root(workbook).iter():
        if _local(node.tag) != "sheet":
            continue
        spec = _sheet_from_node(node, rels, files, len(specs) + 1)
        if spec is not None:
            specs.append(spec)
        if len(specs) > MAX_SHEETS:
            _invalid()
    return specs


def _sheet_specs(files):
    specs = _listed_sheets(files)
    if specs:
        return specs
    fallback = _fallback_names(files)
    if not fallback:
        _invalid()
    return fallback


def _join_sheets(sheets):
    blocks = [f"[Sheet: {sheet['sheetName']}]\n{sheet['tsvText']}" for sheet in sheets]
    return "\n\n".join(blocks)


def _float_or_none(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip().replace(",", "").replace("−", "-")
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _decimals(token):
    match = re.search(r"\.(\d+)", str(token or ""))
    if match is None:
        return 0
    return len(match.group(1))


def _tolerance(token):
    return max(1e-6, 0.5 * (10 ** (-_decimals(token)))) + 1e-9


def _is_mismatch(computed, cached):
    number = _float_or_none(cached)
    if computed is None or number is None:
        return False
    return abs(float(computed) - number) > _tolerance(cached)


def _index_sheet(sheet):
    values = {_norm_ref(key): value for key, value in (sheet.get("values") or {}).items()}
    numbers = {}
    for ref, text in values.items():
        number = _float_or_none(text)
        if number is not None:
            numbers[ref] = number
    formulas = {}
    for cell in sheet.get("formulaCells") or []:
        if isinstance(cell, dict) and cell.get("ref"):
            formulas[_norm_ref(cell["ref"])] = cell
    return {
        "sheetName": sheet.get("sheetName") or "",
        "values": values,
        "numbers": numbers,
        "formulas": formulas,
    }


def _book_index(parsed):
    sheets = [_index_sheet(sheet) for sheet in parsed.get("sheets") or [] if isinstance(sheet, dict)]
    return {
        "name": parsed.get("name") or "workbook.xlsx",
        "sheets": sheets,
        "by_name": {sheet["sheetName"]: sheet for sheet in sheets},
    }


def _find_sheet(book, token, current):
    if not token:
        return current
    exact = book["by_name"].get(token)
    if exact is not None:
        return exact
    folded = [sheet for name, sheet in book["by_name"].items() if name.casefold() == token.casefold()]
    if len(folded) == 1:
        return folded[0]
    return None


def _expand_refs(start, end):
    first = _split_ref(start)
    last = _split_ref(end or start)
    if first is None or last is None:
        return None
    row_lo, row_hi = sorted((first[0], last[0]))
    col_lo, col_hi = sorted((first[1], last[1]))
    count = (row_hi - row_lo + 1) * (col_hi - col_lo + 1)
    if count <= 0 or count > MAX_CELLS:
        return None
    refs = []
    for row in range(row_lo, row_hi + 1):
        for col in range(col_lo, col_hi + 1):
            refs.append(_ref(col, row))
    return refs


def _range_values(piece, sheet, book):
    parsed = _RANGE_RE.match(piece.strip())
    if parsed is None:
        return None
    target = _find_sheet(book, parsed.group("quoted") or parsed.group("bare"), sheet)
    if target is None:
        return None
    refs = _expand_refs(parsed.group("start"), parsed.group("end"))
    if refs is None:
        return None
    values = []
    for ref in refs:
        number = target["numbers"].get(ref)
        if number is not None:
            values.append(number)
    return values


def _split_args(args):
    parts, buf, quoted = [], [], False
    for char in args:
        if char == "'":
            quoted = not quoted
            buf.append(char)
        elif char == "," and not quoted:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(char)
    parts.append("".join(buf))
    return parts


def _arg_values(args, sheet, book):
    values = []
    for piece in _split_args(args):
        got = _range_values(piece.strip(), sheet, book)
        if got is None:
            return None
        values.extend(got)
    return values


def _aggregate(name, values):
    key = name.upper()
    if key == "COUNT":
        return float(len(values))
    if not values:
        return 0.0 if key == "SUM" else None
    if key == "SUM":
        return float(sum(values))
    if key in {"AVERAGE", "MEAN"}:
        return float(sum(values) / len(values))
    if key == "MIN":
        return float(min(values))
    if key == "MAX":
        return float(max(values))
    return None


def _eval_func(name, args, sheet, book):
    values = _arg_values(args, sheet, book)
    if values is None:
        return None
    return _aggregate(name, values)


def _apply_op(left, op, right):
    if op == "+":
        return left + right
    if op == "-":
        return left - right
    if op == "*":
        return left * right
    if right == 0:
        return None
    return left / right


def _num_at(sheet, ref):
    return sheet["numbers"].get(_norm_ref(ref))


def _eval_binary(match, sheet):
    left = _num_at(sheet, match.group("a"))
    right = _num_at(sheet, match.group("b"))
    if left is None or right is None:
        return None
    value = _apply_op(left, match.group("op"), right)
    if value is None:
        return None
    scale = match.group("scale")
    if scale is not None:
        return value * float(scale)
    return value


def _eval_formula(formula, sheet, book):
    text = _clean_formula(formula)
    func = _FUNC_RE.match(text)
    if func:
        return _eval_func(func.group(1), func.group(2), sheet, book)
    binary = _BIN_RE.match(text)
    if binary:
        return _eval_binary(binary, sheet)
    return None


def _coerce_page(item, index):
    if isinstance(item, str):
        return {"pageIndex": index, "id": f"p{index}", "text": item}
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        page = item[0] if type(item[0]) is int else index
        return {"pageIndex": page, "id": f"p{index}", "text": str(item[1])}
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        page = item.get("pageIndex", index)
        if type(page) is not int:
            page = index
        ident = item.get("id", f"p{index}")
        return {"pageIndex": page, "id": ident, "text": item["text"]}
    return None


def _coerce_pages(page_items):
    if isinstance(page_items, str):
        return [{"pageIndex": 0, "id": "p0", "text": page_items}]
    pages = []
    for index, item in enumerate(page_items or []):
        page = _coerce_page(item, index)
        if page is not None:
            pages.append(page)
    return pages


def _split_sentences(page):
    sentences = []
    for part in re.split(r"(?<=[.!?])\s+|\n+", page["text"]):
        cleaned = " ".join(part.split())
        if cleaned:
            sentences.append({"pageIndex": page["pageIndex"], "id": page.get("id"), "text": cleaned})
    return sentences


def _page_sentences(page_items):
    sentences = []
    for page in _coerce_pages(page_items):
        sentences.extend(_split_sentences(page))
    return sentences


def _has_token(text, token):
    if not token:
        return False
    pattern = r"(?<![\d.])" + re.escape(str(token)) + r"(?!\d)"
    return re.search(pattern, text) is not None


def _sheet_mentioned(text, sheet_name):
    return bool(sheet_name) and sheet_name.lower() in text.lower()


def _matching_sentence(page_items, sheet_name, token):
    best = None
    for sentence in _page_sentences(page_items):
        has_token = _has_token(sentence["text"], token)
        if has_token and _sheet_mentioned(sentence["text"], sheet_name):
            return sentence
        if has_token and best is None:
            best = sentence
    return best


def _anchor_excerpt(page_items, sheet_name, token, summary):
    hit = _matching_sentence(page_items, sheet_name, token)
    if hit is None:
        return 0, None, summary[:220]
    excerpt = " ".join(hit["text"].split())[:220]
    return hit["pageIndex"], hit.get("id"), excerpt


def _signal_summary(sheet, ref, formula, reported, computed):
    value = computed
    if isinstance(computed, dict):
        value = computed.get("value")
    return f"Sheet {sheet} cell {ref} formula {formula} cached {reported} computed {value}"


def _located_signal(kind, subtype, book, sheet, ref, formula, reported, computed, page_items):
    summary = _signal_summary(sheet["sheetName"], ref, formula, reported, computed)
    page, segment, excerpt = _anchor_excerpt(page_items, sheet["sheetName"], str(reported), summary)
    return {
        "kind": kind,
        "family": "D1",
        "subtype": subtype,
        "pageIndex": page,
        "segmentId": segment,
        "excerpt": excerpt[:220],
        "detail": summary[:220],
        "variable": ref,
        "group": sheet["sheetName"],
        "supplementName": book["name"],
        "supplementFile": book["name"],
        "sheetName": sheet["sheetName"],
        "cellRef": ref,
        "formula": formula,
        "reported": reported,
        "computed": {"value": computed, "sheetName": sheet["sheetName"]},
    }


def _formula_signals(sheet, book, page_items, limit):
    signals = []
    for cell in sheet["formulas"].values():
        computed = _eval_formula(cell.get("formula") or "", sheet, book)
        cached = cell.get("cachedValue")
        if not _is_mismatch(computed, cached):
            continue
        ref = _norm_ref(cell.get("ref"))
        signal = _located_signal(
            "xlsx_formula_value_mismatch", "xlsx-formula-cached-mismatch",
            book, sheet, ref, cell.get("formula") or "", cached, computed, page_items,
        )
        signals.append(signal)
        if len(signals) >= limit:
            break
    return signals


def _last_row(sheet):
    rows = []
    for ref in sheet["values"]:
        parts = _split_ref(ref)
        if parts is not None:
            rows.append(parts[0])
    if not rows:
        return None
    return max(rows)


def _summary_kind(label):
    token = re.sub(r"[:\s]+$", "", str(label or "").strip().lower())
    if token in _SUM_LABELS:
        return "SUM"
    if token in _MEAN_LABELS:
        return "MEAN"
    return None


def _column_values(sheet, col, last_row):
    values = []
    for ref, number in sheet["numbers"].items():
        parts = _split_ref(ref)
        if parts is not None and parts[1] == col and parts[0] < last_row:
            values.append(number)
    return values


def _column_aggregate(sheet, col, last_row, kind):
    values = _column_values(sheet, col, last_row)
    if not values:
        return None
    if kind == "SUM":
        return float(sum(values))
    return float(sum(values) / len(values))


def _row_cells(sheet, row):
    found = []
    for ref, text in sheet["values"].items():
        parts = _split_ref(ref)
        if parts is not None and parts[0] == row:
            found.append((parts[1], text))
    return found


def _summary_candidate(sheet, col, text, last_row, kind):
    ref = _ref(col, last_row)
    if ref in sheet["formulas"] or _float_or_none(text) is None:
        return None
    expected = _column_aggregate(sheet, col, last_row, kind)
    if expected is None or not _is_mismatch(expected, text):
        return None
    return ref, expected


def _summary_signals(sheet, book, page_items, limit):
    last_row = _last_row(sheet)
    kind = _summary_kind(sheet["values"].get(_ref(0, last_row), "")) if last_row else None
    if kind is None:
        return []
    signals = []
    for col, text in _row_cells(sheet, last_row):
        if col == 0:
            continue
        found = _summary_candidate(sheet, col, text, last_row, kind)
        if found is None:
            continue
        ref, expected = found
        signal = _located_signal(
            "xlsx_summary_row_mismatch", "xlsx-hardcoded-total-mismatch",
            book, sheet, ref, kind, text, expected, page_items,
        )
        signals.append(signal)
        if len(signals) >= limit:
            break
    return signals


def _check_limit(max_signals):
    if type(max_signals) is not int or isinstance(max_signals, bool):
        raise ValueError("limit")
    if not 1 <= max_signals <= 100:
        raise ValueError("limit")


def audit_xlsx_formulas(parsed_workbook, *, page_items=None, max_signals=30):
    """Compare cached formula results and hardcoded totals with static arithmetic."""
    _check_limit(max_signals)
    _assert_no_red_keys(parsed_workbook)
    _assert_no_red_keys(page_items)
    book = _book_index(parsed_workbook if isinstance(parsed_workbook, dict) else {})
    signals = []
    for sheet in book["sheets"]:
        room = max_signals - len(signals)
        if room <= 0:
            break
        signals.extend(_formula_signals(sheet, book, page_items, room))
        room = max_signals - len(signals)
        if room <= 0:
            break
        signals.extend(_summary_signals(sheet, book, page_items, room))
    return signals


def parse_xlsx_workbook(raw_bytes, *, name="workbook.xlsx"):
    """Parse a workbook into sheet grids and static formula signals."""
    if not isinstance(raw_bytes, (bytes, bytearray)):
        _invalid()
    files = _load_xlsx_files(bytes(raw_bytes))
    shared_text = files.get("xl/sharedstrings.xml")
    shared = _shared_strings(shared_text)
    counter = [0]
    sheets = []
    for title, path in _sheet_specs(files):
        sheets.append(_build_sheet(title, files[path], shared, counter))
    parsed = {
        "name": name or "workbook.xlsx",
        "sheets": sheets,
        "text": _join_sheets(sheets),
        "formulaSignals": [],
    }
    parsed["formulaSignals"] = audit_xlsx_formulas(parsed)
    return parsed


def _as_text(raw):
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        try:
            return bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            _invalid()
    _invalid()


def _load_notebook(raw_text):
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        _invalid()
    if not isinstance(parsed, dict) or not isinstance(parsed.get("cells"), list):
        _invalid()
    _assert_no_red_keys(parsed)
    return parsed


def _join_source(source):
    if isinstance(source, list):
        return "".join(str(part) for part in source)
    if isinstance(source, str):
        return source
    return ""


def _normalize_language(raw):
    token = str(raw or "python").lower()
    if token in _R_LANGUAGES:
        return "r"
    return "python"


def _kernel_language(notebook):
    meta = notebook.get("metadata") if isinstance(notebook.get("metadata"), dict) else {}
    info = meta.get("language_info") if isinstance(meta.get("language_info"), dict) else {}
    spec = meta.get("kernelspec") if isinstance(meta.get("kernelspec"), dict) else {}
    raw = info.get("name") or spec.get("language") or spec.get("name") or "python"
    return _normalize_language(raw)


def _cell_language(cell, default):
    meta = cell.get("metadata") if isinstance(cell.get("metadata"), dict) else {}
    return _normalize_language(meta.get("language") or default)


def _text_lines(value):
    if isinstance(value, list):
        return [str(part) for part in value]
    if isinstance(value, str):
        return value.splitlines()
    return []


def _is_base64_blob(text):
    compact = "".join(str(text).split())
    if len(compact) < 160:
        return False
    return re.fullmatch(r"[A-Za-z0-9+/=]+", compact) is not None


def _output_record_lines(output):
    kind = output.get("output_type")
    if kind == "stream":
        return _text_lines(output.get("text"))
    data = output.get("data")
    if kind in {"execute_result", "display_data"} and isinstance(data, dict):
        return _text_lines(data.get("text/plain"))
    return []


def _kept_outputs(cell):
    lines = []
    for output in cell.get("outputs") or []:
        if isinstance(output, dict):
            lines.extend(_output_record_lines(output))
    return [line for line in lines if line and not _is_base64_blob(line)]


def _cell_label(kind):
    if kind == "markdown":
        return "markdown"
    if kind == "code":
        return "code"
    return kind


def _readable_blocks(index, cell):
    kind = str(cell.get("cell_type") or "raw")
    source = _join_source(cell.get("source")).strip()
    blocks = [f"[Cell {index} {_cell_label(kind)}] {source}".rstrip()]
    if kind != "code":
        return blocks
    outputs = "\n".join(_kept_outputs(cell)).strip()
    if outputs:
        blocks.append(f"[Cell {index} output] {outputs}")
    return blocks


def _code_cell(index, cell, language):
    if cell.get("cell_type") != "code":
        return None
    count = cell.get("execution_count")
    if type(count) is not int:
        count = None
    return {
        "cellIndex": index,
        "executionCount": count,
        "language": _cell_language(cell, language),
        "source": _join_source(cell.get("source")),
        "startLine": 1,
    }


def _first_source_line(offsets, cell_index):
    for line_no, item in enumerate(offsets, start=1):
        if item["cellIndex"] == cell_index and item["cellLine"] > 0:
            return line_no
    for line_no, item in enumerate(offsets, start=1):
        if item["cellIndex"] == cell_index:
            return line_no
    return 1


def _combined_code(code_cells):
    lines, offsets = [], []
    for cell in code_cells:
        lines.append(f"# [cell {cell['cellIndex']}]")
        offsets.append({"cellIndex": cell["cellIndex"], "cellLine": 0})
        for number, line in enumerate(cell["source"].splitlines(), start=1):
            lines.append(line)
            offsets.append({"cellIndex": cell["cellIndex"], "cellLine": number})
        cell["startLine"] = _first_source_line(offsets, cell["cellIndex"])
    text = "\n".join(lines)
    if lines:
        text += "\n"
    return text, offsets


def _anomaly(cell, previous, count):
    direction = "backwards" if count < previous else "skip"
    return {
        "cellIndex": cell["cellIndex"],
        "previousCount": previous,
        "executionCount": count,
        "advisoryOnly": True,
        "direction": direction,
    }


def _execution_anomalies(code_cells):
    anomalies, previous = [], None
    for cell in code_cells:
        count = cell.get("executionCount")
        if type(count) is not int:
            continue
        if previous is not None and (count < previous or count > previous + 1):
            anomalies.append(_anomaly(cell, previous, count))
        previous = count
    return anomalies


def parse_ipynb_notebook(raw_bytes_or_text, *, name="notebook.ipynb"):
    """Read a notebook structurally. Code cells and outputs are never executed."""
    raw_text = _as_text(raw_bytes_or_text)
    notebook = _load_notebook(raw_text)
    language = _kernel_language(notebook)
    code_cells, output_lines, readable = [], [], []
    for index, cell in enumerate(notebook.get("cells") or []):
        if not isinstance(cell, dict):
            continue
        readable.extend(_readable_blocks(index + 1, cell))
        output_lines.extend(_kept_outputs(cell))
        code = _code_cell(index, cell, language)
        if code is not None:
            code_cells.append(code)
    combined, offsets = _combined_code(code_cells)
    return {
        "name": name or "notebook.ipynb",
        "language": language,
        "codeCells": code_cells,
        "combinedCode": combined,
        "lineOffsets": offsets,
        "outputLines": output_lines,
        "text": "\n".join(readable),
        "executionOrderAnomalies": _execution_anomalies(code_cells),
        "rawText": raw_text,
    }


def extract_rmd_qmd_chunks(text, *, name="analysis.Rmd"):
    """Return fenced `{r}` and `{python}` chunks with 1-based file line numbers."""
    source = text if isinstance(text, str) else ""
    chunks = []
    for match in _CHUNK_RE.finditer(source):
        chunks.append({
            "name": name,
            "language": match.group("lang").lower(),
            "code": match.group("body").replace("\r\n", "\n").replace("\r", "\n"),
            "startLine": source.count("\n", 0, match.start("body")) + 1,
        })
    return chunks
