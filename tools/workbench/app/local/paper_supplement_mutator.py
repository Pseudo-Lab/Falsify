"""Structure-preserving RED mutations for xlsx cells and ipynb cells.

UTF-8 supplements still go through paper_text_span_mutator. Workbook and notebook
bytes stay byte-for-byte identical unless an xlsx-cell or ipynb-cell operation
targets that supplement. XML is parsed with the workbook loader's XXE and
zip-bomb guards; cells and macros are never executed.
"""
import base64
import hashlib
import io
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from paper_supplement_audit import infer_supplement_kind
from paper_tabular_notebook_loader import (
    _attr,
    _cell_value,
    _load_xlsx_files,
    _local,
    _norm_ref,
    _shared_strings,
    _sheet_specs,
    _xml_root,
    parse_ipynb_notebook,
    parse_xlsx_workbook,
)
from paper_text_span_mutator import (
    FORBIDDEN_RED_KEYS,
    MAX_SUPPLEMENT_BYTES,
    MAX_SUPPLEMENTS,
    SUPPLEMENT_SCHEMA,
    SpanMutationError,
    assert_blind_supplements,
    load_red_supplements,
    mutate_supplements,
    normalize_supplements,
)

_HINT_TOKENS = (
    'intentional', 'fabricated', 'fake-doi', 'red-team', 'injected', 'falsify-red',
    'red-plan', 'answer-key', 'answer_key', 'tampered', 'falsify', '변조', '가짜', '함정', '정답',
)
_CELL_RE = re.compile(r'^[A-Z]{1,3}[1-9]\d{0,6}$')
_COUNT_RE = re.compile(r'-?\d+')
_MAX_ENTRIES = 256
_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
_CELL_HINT = 'Cell value did not match. Retry with a sheet, cell, and value from nearestCandidates.'
_SHEET_HINT = 'Sheet was not found. Retry with a sheet name and cell from nearestCandidates.'
_RANGE_HINT = 'cellIndex is outside the notebook. Retry with a cellIndex from nearestCandidates.'
_IPYNB_HINT = 'Notebook cell did not contain before. Retry with a cellIndex, target, and before from nearestCandidates.'
_HINT_HINT = 'Remove RED hint tokens from after and afterFormula, then retry.'


def _has_forbidden_text(text):
    lowered = str(text or '').lower()
    for token in _HINT_TOKENS:
        if token.lower() in lowered:
            return True
    for token in FORBIDDEN_RED_KEYS:
        if str(token).lower() in lowered:
            return True
    return False


def _reject_hints(op):
    for key in ('after', 'afterFormula'):
        value = op.get(key)
        if value is None or not _has_forbidden_text(value):
            continue
        shown = value if isinstance(value, str) else str(value)
        raise SpanMutationError('blindness_hint_token_forbidden', {
            'actualValue': shown,
            'nearestCandidates': [],
            'recoveryHint': _HINT_HINT,
        })


def _required_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _check_total(size, total):
    if size > MAX_SUPPLEMENT_BYTES or total + size > MAX_SUPPLEMENT_BYTES:
        raise ValueError('supplement_size_limit')
    return total + size


def _read_file(path, total):
    if not path.is_file():
        raise ValueError('supplement_file_invalid')
    try:
        raw = path.read_bytes()
    except OSError:
        raise ValueError('supplement_file_invalid') from None
    return raw, _check_total(len(raw), total)


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _base_record(index, name, raw, text, kind):
    return {
        'supplementId': f'supp-{index}',
        'name': name,
        'kind': kind or infer_supplement_kind(name),
        'sha256': _digest(raw),
        'sizeBytes': len(raw),
        'lineCount': len(text.splitlines()),
        'text': text,
        'rawBytes': raw,
        'contentBase64': base64.b64encode(raw).decode('ascii'),
    }


def _named(entry, index, suffix):
    return Path(str(entry.get('name') or f'supplement-{index}{suffix}')).name


def _raw_of(rec):
    if not isinstance(rec, dict):
        return None
    for key in ('rawBytes', 'bytes'):
        raw = rec.get(key)
        if isinstance(raw, (bytes, bytearray)) and raw:
            return bytes(raw)
    encoded = rec.get('contentBase64')
    if not isinstance(encoded, str) or not encoded:
        return None
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        return None


def _load_plain(path, index, total):
    rec = load_red_supplements([str(path)])[0]
    rec['supplementId'] = f'supp-{index}'
    return rec, _check_total(rec['sizeBytes'], total)


def _load_xlsx(path, index, total):
    raw, new_total = _read_file(path, total)
    parsed = parse_xlsx_workbook(raw, name=path.name)
    rec = _base_record(index, path.name, raw, parsed.get('text') or '', infer_supplement_kind(path.name))
    rec['format'] = 'xlsx'
    rec['sheets'] = parsed.get('sheets') or []
    return rec, new_total


def _decode_notebook(raw):
    if b'\x00' in raw:
        raise ValueError('supplement_encoding_invalid')
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('supplement_encoding_invalid') from None


def _load_ipynb(path, index, total):
    raw, new_total = _read_file(path, total)
    text = _decode_notebook(raw)
    parsed = parse_ipynb_notebook(text, name=path.name)
    notebook = json.loads(parsed.get('rawText') or text)
    rec = _base_record(index, path.name, raw, parsed.get('rawText') or text, infer_supplement_kind(path.name))
    rec['format'] = 'ipynb'
    rec['notebook'] = notebook
    return rec, new_total


def _load_any(path, index, total):
    suffix = path.suffix.lower()
    if suffix == '.xlsx':
        return _load_xlsx(path, index, total)
    if suffix == '.ipynb':
        return _load_ipynb(path, index, total)
    return _load_plain(path, index, total)


def load_red_supplements_extended(paths):
    """Load up to 12 text, xlsx, or ipynb supplements (10 MiB total)."""
    if not paths:
        return []
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    loaded, total = [], 0
    for index, item in enumerate(paths):
        rec, total = _load_any(Path(item), index, total)
        loaded.append(rec)
    assert_blind_supplements(loaded)
    return loaded


def _is_path(item):
    return isinstance(item, (str, Path))


def _plain_text_dict(entry):
    if not isinstance(entry, dict) or not isinstance(entry.get('text'), str):
        return False
    if entry.get('format') in ('xlsx', 'ipynb'):
        return False
    if entry.get('rawBytes') is not None or entry.get('bytes') is not None or entry.get('contentBase64'):
        return False
    name = str(entry.get('name') or '').lower()
    return not name.endswith(('.xlsx', '.ipynb'))


def _dict_kind(entry):
    declared = entry.get('format')
    if declared in ('xlsx', 'ipynb'):
        return declared
    name = str(entry.get('name') or '').lower()
    if name.endswith('.xlsx'):
        return 'xlsx'
    if name.endswith('.ipynb'):
        return 'ipynb'
    return ''


def _normalize_xlsx_dict(entry, index, total):
    raw = _raw_of(entry)
    if raw is None:
        raise ValueError('supplement_entry_invalid')
    new_total = _check_total(len(raw), total)
    name = _named(entry, index, '.xlsx')
    parsed = parse_xlsx_workbook(raw, name=name)
    kind = entry.get('kind') or infer_supplement_kind(name)
    rec = _base_record(index, name, raw, parsed.get('text') or '', kind)
    rec['supplementId'] = str(entry.get('supplementId') or rec['supplementId'])
    rec['format'] = 'xlsx'
    rec['sheets'] = parsed.get('sheets') or []
    return rec, new_total


def _ipynb_raw(entry):
    raw = _raw_of(entry)
    if raw is not None:
        return raw
    text = entry.get('text')
    if isinstance(text, str):
        return text.encode('utf-8')
    return None


def _normalize_ipynb_dict(entry, index, total):
    raw = _ipynb_raw(entry)
    if raw is None:
        raise ValueError('supplement_entry_invalid')
    text = _decode_notebook(raw)
    new_total = _check_total(len(raw), total)
    name = _named(entry, index, '.ipynb')
    parsed = parse_ipynb_notebook(text, name=name)
    notebook = json.loads(parsed.get('rawText') or text)
    kind = entry.get('kind') or infer_supplement_kind(name)
    rec = _base_record(index, name, raw, parsed.get('rawText') or text, kind)
    rec['supplementId'] = str(entry.get('supplementId') or rec['supplementId'])
    rec['format'] = 'ipynb'
    rec['notebook'] = notebook
    return rec, new_total


def _normalize_plain_dict(entry, index, total):
    rec = normalize_supplements([entry])[0]
    rec['supplementId'] = str(entry.get('supplementId') or f'supp-{index}')
    return rec, _check_total(rec['sizeBytes'], total)


def _normalize_item(item, index, total):
    if _is_path(item):
        return _load_any(Path(item), index, total)
    if not isinstance(item, dict):
        raise ValueError('supplement_entry_invalid')
    if _plain_text_dict(item):
        return _normalize_plain_dict(item, index, total)
    kind = _dict_kind(item)
    if kind == 'xlsx':
        return _normalize_xlsx_dict(item, index, total)
    if kind == 'ipynb':
        return _normalize_ipynb_dict(item, index, total)
    raise ValueError('supplement_entry_invalid')


def _normalize_each(items):
    loaded, total = [], 0
    for index, item in enumerate(items):
        rec, total = _normalize_item(item, index, total)
        loaded.append(rec)
    assert_blind_supplements(loaded)
    return loaded


def normalize_red_supplements_extended(supplements):
    """Normalize paths or records, keeping xlsx and ipynb bytes attached."""
    if not supplements:
        return []
    if not isinstance(supplements, (list, tuple)) or len(supplements) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    items = list(supplements)
    if all(_is_path(item) for item in items):
        return load_red_supplements_extended(items)
    if all(_plain_text_dict(item) for item in items):
        loaded = normalize_supplements(items)
        assert_blind_supplements(loaded)
        return loaded
    return _normalize_each(items)


def _formula_map(sheet):
    found = {}
    for item in sheet.get('formulaCells') or []:
        if isinstance(item, dict) and item.get('ref'):
            found[item['ref']] = item.get('formula') or ''
    return found


def _candidate_row(sheet, ref, text, formula):
    shown = '' if text is None else str(text)
    if not shown.strip() and not formula:
        return None
    return {
        'sheet': sheet.get('sheetName') or '',
        'cell': ref,
        'value': shown,
        'formula': formula or None,
    }


def _sheet_candidates(sheet):
    formulas = _formula_map(sheet)
    rows = []
    for ref, text in (sheet.get('values') or {}).items():
        row = _candidate_row(sheet, ref, text, formulas.get(ref) or '')
        if row is not None:
            rows.append(row)
    return rows


def _nearest_cells(parsed, limit=5):
    rows = []
    for sheet in (parsed or {}).get('sheets') or []:
        rows.extend(_sheet_candidates(sheet))
        if len(rows) >= limit:
            return rows[:limit]
    return rows[:limit]


def _xlsx_fail(code, hint, parsed, actual=None):
    raise SpanMutationError(code, {
        'actualValue': actual,
        'nearestCandidates': _nearest_cells(parsed),
        'recoveryHint': hint,
    })


def _parsed_sheets(rec):
    sheets = rec.get('sheets') if isinstance(rec, dict) else None
    if isinstance(sheets, list):
        return {'sheets': sheets}
    return {'sheets': []}


def _open_zip(raw):
    try:
        return zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ValueError('supplement_file_invalid') from None


def _reject_member(info, total):
    name = str(info.filename or '').replace('\\', '/')
    leaked = info.flag_bits & 0x1 or name.startswith('/') or '..' in name.split('/')
    if leaked:
        raise ValueError('supplement_file_invalid')
    if info.file_size > MAX_SUPPLEMENT_BYTES or total + info.file_size > MAX_SUPPLEMENT_BYTES:
        raise ValueError('supplement_size_limit')
    return name


def _zip_members(raw):
    archive = _open_zip(raw)
    members, total = [], 0
    with archive:
        infos = archive.infolist()
        if len(infos) > _MAX_ENTRIES:
            raise ValueError('supplement_size_limit')
        for info in infos:
            if info.is_dir():
                continue
            _reject_member(info, total)
            data = archive.read(info)
            total += len(data)
            if total > MAX_SUPPLEMENT_BYTES:
                raise ValueError('supplement_size_limit')
            members.append((info.filename, data))
    return members


def _member_bytes(members, path):
    folded = str(path or '').replace('\\', '/').lstrip('/').lower()
    for name, data in members:
        if name.replace('\\', '/').lstrip('/').lower() == folded:
            return data
    return None


def _member_text(members, path):
    data = _member_bytes(members, path)
    if data is None:
        return None
    try:
        return data.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ValueError('supplement_encoding_invalid') from None


def _match_sheet(specs, sheet_name):
    if not specs:
        return None
    if sheet_name is None or sheet_name == '':
        return specs[0]
    wanted = str(sheet_name).casefold()
    for title, path in specs:
        if str(title).casefold() == wanted:
            return title, path
    return None


def _cell_ref(value):
    ref = _norm_ref(value)
    if _CELL_RE.fullmatch(ref or ''):
        return ref
    return None


def _ns_name(node, name):
    tag = node.tag if node is not None else ''
    if isinstance(tag, str) and tag.startswith('{') and '}' in tag:
        return tag.split('}', 1)[0] + '}' + name
    return name


def _make(node, name, text=None):
    element = ET.Element(_ns_name(node, name))
    if text is not None:
        element.text = text
    return element


def _drop_local(node, names):
    for child in list(node):
        if _local(child.tag) in names:
            node.remove(child)


def _pop_local_attr(node, name):
    for key in list(node.attrib):
        if _local(key) == name:
            node.attrib.pop(key, None)


def _is_number_text(text):
    return re.fullmatch(r'-?\d+(\.\d+)?', str(text or '').strip()) is not None


def _write_number(node, after):
    _pop_local_attr(node, 't')
    _drop_local(node, {'v', 'is'})
    node.append(_make(node, 'v', after.strip()))


def _write_inline(node, after):
    _pop_local_attr(node, 't')
    node.set('t', 'inlineStr')
    _drop_local(node, {'v', 'is'})
    box = _make(node, 'is')
    box.append(_make(node, 't', after))
    node.append(box)


def _apply_after(node, after):
    if _is_number_text(after):
        _write_number(node, after)
        return
    _write_inline(node, after)


def _clean_formula(text):
    cleaned = str(text or '').strip()
    if cleaned.startswith('='):
        return cleaned[1:].strip()
    return cleaned


def _set_formula(node, after_formula):
    if after_formula is None:
        return
    text = _clean_formula(after_formula)
    for child in list(node):
        if _local(child.tag) != 'f':
            continue
        if text:
            child.text = text
        else:
            node.remove(child)
        return
    if text:
        node.insert(0, _make(node, 'f', text))


def _find_cell(root, ref):
    for node in root.iter():
        if _local(node.tag) != 'c':
            continue
        if _norm_ref(_attr(node, 'r')) == ref:
            return node
    return None


def _same_before(current, before):
    if before is None:
        return True
    return str(current or '') == str(before)


def _mutate_sheet_xml(xml_text, shared_text, ref, after, after_formula, before, parsed):
    root = _xml_root(xml_text)
    node = _find_cell(root, ref)
    if node is None:
        _xlsx_fail('xlsx_cell_before_mismatch', _CELL_HINT, parsed, before)
    shared = _shared_strings(shared_text) if shared_text else []
    current, _formula, _cached = _cell_value(node, shared)
    if not _same_before(current, before):
        _xlsx_fail('xlsx_cell_before_mismatch', _CELL_HINT, parsed, current)
    _set_formula(node, after_formula)
    _apply_after(node, after)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True), current


def _repack(members, replace_name, payload):
    target = str(replace_name or '').replace('\\', '/').lstrip('/').lower()
    out = io.BytesIO()
    found = False
    with zipfile.ZipFile(out, 'w') as dest:
        for name, data in members:
            current = data
            folded = name.replace('\\', '/').lstrip('/').lower()
            if folded == target:
                current = payload
                found = True
            info = zipfile.ZipInfo(filename=name, date_time=_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            dest.writestr(info, current)
    if not found:
        raise ValueError('xlsx_sheet_not_found')
    return out.getvalue()


def _store_raw(rec, raw, text, sheets=None, notebook=None):
    rec['rawBytes'] = raw
    rec['contentBase64'] = base64.b64encode(raw).decode('ascii')
    rec['text'] = text
    rec['sha256'] = _digest(raw)
    rec['sizeBytes'] = len(raw)
    rec['lineCount'] = len(str(text or '').splitlines())
    if sheets is not None:
        rec['sheets'] = sheets
    if notebook is not None:
        rec['notebook'] = notebook


def _refresh_xlsx(rec, raw):
    parsed = parse_xlsx_workbook(raw, name=rec.get('name') or 'workbook.xlsx')
    _store_raw(rec, raw, parsed.get('text') or '', sheets=parsed.get('sheets') or [])


def _logical_xlsx(rec, op, after, before, parsed):
    text = str(rec.get('text') or '')
    if before is not None and str(before) not in text:
        _xlsx_fail('xlsx_cell_before_mismatch', _CELL_HINT, parsed, before)
    if before is not None:
        rec['text'] = text.replace(str(before), after, 1)
    return str(before) if before is not None else ''


def _mutate_xlsx_bytes(raw, op, after, after_formula, before):
    parsed = parse_xlsx_workbook(raw, name='workbook.xlsx')
    ref = _cell_ref(op.get('cell'))
    if ref is None:
        _xlsx_fail('xlsx_cell_before_mismatch', _CELL_HINT, parsed, op.get('cell'))
    found = _match_sheet(_sheet_specs(_load_xlsx_files(raw)), op.get('sheet'))
    if found is None:
        _xlsx_fail('xlsx_sheet_not_found', _SHEET_HINT, parsed, op.get('sheet'))
    _title, path = found
    members = _zip_members(raw)
    xml_text = _member_text(members, path)
    if xml_text is None:
        _xlsx_fail('xlsx_sheet_not_found', _SHEET_HINT, parsed, op.get('sheet'))
    shared = _member_text(members, 'xl/sharedstrings.xml')
    new_xml, current = _mutate_sheet_xml(
        xml_text, shared, ref, after, after_formula, before, parsed,
    )
    return _repack(members, path, new_xml), current


def _change(op, index, kind, rec, before, after, extra=None):
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'{kind}-op-{index}'
    row = {
        'id': op_id,
        'kind': kind,
        'supplementId': rec.get('supplementId'),
        'supplementName': rec.get('name'),
        'before': before,
        'after': after,
    }
    if extra:
        row.update(extra)
    return row


def _apply_xlsx(state, op, index):
    _reject_hints(op)
    rec = _resolve_rec(state, op)
    parsed = _parsed_sheets(rec)
    after = _required_text(op.get('after'))
    if after is None:
        _xlsx_fail('xlsx_cell_before_mismatch', _CELL_HINT, parsed, op.get('after'))
    before = op.get('before')
    after_formula = op.get('afterFormula')
    raw = _raw_of(rec)
    if raw is None:
        current = _logical_xlsx(rec, op, after, before, parsed)
    else:
        updated, current = _mutate_xlsx_bytes(raw, op, after, after_formula, before)
        _refresh_xlsx(rec, updated)
    extra = {'sheet': op.get('sheet'), 'cell': _cell_ref(op.get('cell')) or op.get('cell')}
    if after_formula is not None:
        extra['afterFormula'] = after_formula
    return _change(op, index, 'xlsx-cell', rec, current, after, extra)


def _join_parts(value):
    if isinstance(value, list):
        return ''.join(str(part) for part in value)
    if isinstance(value, str):
        return value
    return ''


def _as_source(current, text):
    if isinstance(current, str):
        return text
    if text == '':
        return []
    return text.splitlines(keepends=True) or [text]


def _output_text(output):
    if not isinstance(output, dict):
        return ''
    if output.get('output_type') == 'stream':
        return _join_parts(output.get('text'))
    data = output.get('data')
    if isinstance(data, dict):
        return _join_parts(data.get('text/plain'))
    return ''


def _join_outputs(cell):
    parts = []
    for output in cell.get('outputs') or []:
        text = _output_text(output)
        if text:
            parts.append(text)
    return ''.join(parts)


def _count_or_none(cell):
    count = cell.get('execution_count')
    if type(count) is int:
        return count
    return None


def _ipynb_candidates(notebook, limit=5):
    rows = []
    for index, cell in enumerate((notebook or {}).get('cells') or []):
        if not isinstance(cell, dict):
            continue
        rows.append({
            'cellIndex': index,
            'cellType': cell.get('cell_type'),
            'source': _join_parts(cell.get('source'))[:120],
            'output': _join_outputs(cell)[:120],
            'executionCount': _count_or_none(cell),
        })
        if len(rows) >= limit:
            break
    return rows


def _ipynb_fail(code, hint, notebook, actual=None):
    raise SpanMutationError(code, {
        'actualValue': actual,
        'nearestCandidates': _ipynb_candidates(notebook),
        'recoveryHint': hint,
    })


def _notebook_from_raw(raw):
    if raw is None:
        return None
    text = _decode_notebook(raw)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError('supplement_file_invalid') from None


def _notebook_from_text(rec):
    notebook = rec.get('notebook')
    if isinstance(notebook, dict) and isinstance(notebook.get('cells'), list):
        return json.loads(json.dumps(notebook))
    text = str(rec.get('text') or '')
    if not text.lstrip().startswith('{'):
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ValueError('supplement_file_invalid') from None


def _notebook_from_rec(rec):
    loaded = _notebook_from_raw(_raw_of(rec))
    if loaded is not None:
        return loaded
    return _notebook_from_text(rec)


def _dump_notebook(notebook):
    return json.dumps(notebook, ensure_ascii=False, indent=1) + '\n'


def _refresh_ipynb(rec, notebook):
    text = _dump_notebook(notebook)
    _store_raw(rec, text.encode('utf-8'), text, notebook=notebook)


def _assign_source(cell, text):
    cell['source'] = _as_source(cell.get('source'), text)


def _put_output_text(output, text):
    if output.get('output_type') == 'stream':
        output['text'] = _as_source(output.get('text'), text)
        return True
    data = output.get('data')
    if isinstance(data, dict) and 'text/plain' in data:
        data['text/plain'] = _as_source(data.get('text/plain'), text)
        return True
    return False


def _in_range(cells, index):
    if not isinstance(cells, list) or isinstance(index, bool) or type(index) is not int:
        return False
    return 0 <= index < len(cells)


def _edit_source(cell, before, after, notebook):
    current = _join_parts(cell.get('source'))
    if before is None:
        _assign_source(cell, after)
        return current
    if str(before) not in current:
        _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, current[:120])
    _assign_source(cell, current.replace(str(before), after, 1))
    return str(before)


def _edit_output(cell, before, after, notebook):
    for output in cell.get('outputs') or []:
        current = _output_text(output)
        if before is not None and str(before) not in current:
            continue
        updated = after if before is None else current.replace(str(before), after, 1)
        if _put_output_text(output, updated):
            return current if before is None else str(before)
    _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, before)


def _count_after(after):
    if isinstance(after, int) and not isinstance(after, bool):
        return after
    if isinstance(after, str) and _COUNT_RE.fullmatch(after.strip()):
        return int(after.strip())
    return None


def _edit_count(cell, before, after, notebook):
    count = cell.get('execution_count')
    if before is not None and str(count) != str(before):
        _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, count)
    number = _count_after(after)
    if number is None:
        _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, after)
    cell['execution_count'] = number
    return count


def _edit_notebook(notebook, op, before, after):
    cells = notebook.get('cells') if isinstance(notebook, dict) else None
    index = op.get('cellIndex')
    if not _in_range(cells, index) or not isinstance(cells[index], dict):
        _ipynb_fail('ipynb_cell_out_of_range', _RANGE_HINT, notebook, index)
    cell = cells[index]
    target = op.get('target')
    if target == 'source':
        return _edit_source(cell, before, after, notebook)
    if target == 'output':
        return _edit_output(cell, before, after, notebook)
    if target == 'execution_count':
        return _edit_count(cell, before, after, notebook)
    _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, target)


def _apply_ipynb(state, op, index):
    _reject_hints(op)
    rec = _resolve_rec(state, op)
    notebook = _notebook_from_rec(rec)
    if notebook is None:
        _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, {'cells': []}, op.get('target'))
    after = _required_text(op.get('after'))
    if after is None:
        _ipynb_fail('ipynb_cell_before_mismatch', _IPYNB_HINT, notebook, op.get('after'))
    current = _edit_notebook(notebook, op, op.get('before'), after)
    _refresh_ipynb(rec, notebook)
    return _change(op, index, 'ipynb-cell', rec, current, after, {
        'cellIndex': op.get('cellIndex'),
        'target': op.get('target'),
    })


def _resolve_rec(state, op):
    sid = op.get('supplementId')
    name = op.get('name')
    for rec in state.values():
        if sid and (rec.get('supplementId') == sid or rec.get('name') == sid):
            return rec
        if name and rec.get('name') == name:
            return rec
    cands = [
        {'supplementId': rec.get('supplementId'), 'name': rec.get('name')}
        for rec in list(state.values())[:5]
    ]
    raise SpanMutationError('supplement_not_found', {
        'nearestCandidates': cands,
        'recoveryHint': 'Target supplement was not found. Retry with a supplementId or name from nearestCandidates.',
    })


def _apply_cell_op(state, op, index):
    kind = op.get('kind')
    if kind == 'xlsx-cell':
        return _apply_xlsx(state, op, index)
    if kind == 'ipynb-cell':
        return _apply_ipynb(state, op, index)
    raise ValueError('visual_operation_invalid')


def _is_structured_rec(rec):
    if not isinstance(rec, dict):
        return False
    if rec.get('format') in ('xlsx', 'ipynb'):
        return True
    return str(rec.get('name') or '').lower().endswith(('.xlsx', '.ipynb'))


def _split_records(records):
    text, structured = [], []
    for rec in records:
        if _is_structured_rec(rec):
            structured.append(rec)
        else:
            text.append(rec)
    return text, structured


def _split_ops(operations):
    text, cells = [], []
    for op in operations:
        if not isinstance(op, dict):
            raise ValueError('visual_operation_invalid')
        kind = op.get('kind')
        if kind in ('supplement-edit', 'supplement-text'):
            text.append(op)
        elif kind in ('xlsx-cell', 'ipynb-cell'):
            cells.append(op)
        else:
            raise ValueError('visual_operation_invalid')
    return text, cells


def _blind_from_state(rec):
    raw = _raw_of(rec)
    text = rec.get('text') or ''
    if raw is None:
        raw = str(text).encode('utf-8')
    return {
        'supplementId': rec.get('supplementId'),
        'name': rec.get('name'),
        'kind': rec.get('kind'),
        'sha256': _digest(raw),
        'sizeBytes': len(raw),
        'contentBase64': base64.b64encode(raw).decode('ascii'),
        'text': text,
    }


def _merge_blind(originals, text_blind, copies):
    by_text = {rec['supplementId']: rec for rec in text_blind}
    by_copy = {rec['supplementId']: rec for rec in copies}
    ordered = []
    for rec in originals:
        sid = rec.get('supplementId')
        if sid in by_text:
            ordered.append(by_text[sid])
        else:
            ordered.append(_blind_from_state(by_copy[sid]))
    return ordered


def apply_extended_supplement_mutations(supplements, operations):
    """Apply supplement-edit, xlsx-cell, and ipynb-cell operations in memory."""
    if not isinstance(operations, list):
        raise ValueError('visual_operation_invalid')
    originals = list(supplements or [])
    text_recs, structured = _split_records(originals)
    text_ops, cell_ops = _split_ops(operations)
    changes, text_blind = [], []
    if text_recs or text_ops:
        result = mutate_supplements(text_recs, text_ops)
        changes.extend(result['changes'])
        text_blind = result['blindSupplements']
    copies = [dict(rec) for rec in structured]
    state = {rec['supplementId']: rec for rec in copies}
    for index, op in enumerate(cell_ops):
        changes.append(_apply_cell_op(state, op, index))
    blind = _merge_blind(originals, text_blind, copies)
    assert_blind_supplements(blind)
    return {
        'schema': SUPPLEMENT_SCHEMA,
        'appliedCount': len(changes),
        'changes': changes,
        'blindSupplements': blind,
    }
