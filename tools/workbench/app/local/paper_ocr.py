"""Scanned-page OCR for one PNG: RapidOCR lines and img2table cell topology.

Public API:
  recognize(png_bytes, language='en', engine=None, table_engine=None) -> dict

Schema falsify.ocr-page.v1. status is ready, partial, or unavailable.
image is {sha256, width, height} in pixels. language is en or ko when accepted.
lines are {id, text, confidence, bbox:[x0,y0,x1,y1], polygon?} in engine order.
tables are {bbox, rows, columns, title, cells}. A cell is
{row, column, rowSpan, columnSpan, text, bbox, confidence}.
provenance is {engine, version, method, model, language}. issues is a list of
short codes. transforms lists orientation or deskew records. Coordinates are
original-image pixels. Text is copied through; digits, signs, and whitespace
are not rewritten. confidence is null when the engine did not provide a
finite score.

Injection, used by tests and by callers that already hold an engine:

  engine(png_bytes) if engine is callable, otherwise engine.recognize(png_bytes).
  The value may be a RapidOCROutput (boxes, txts, scores), a dict with those
  keys, or {'lines': [{text, confidence, bbox or polygon, angle?}]}. Optional
  transforms is a list of {op, angle?, lineId?, coordinateSpace?}. A 4-number
  box is an axis-aligned bbox. A sequence of points is a polygon and the bbox
  is its min/max. This module does not pass text_score into an injected engine.

  table_engine(png_bytes) if callable, otherwise extract_tables(png_bytes) or
  extract(png_bytes). None or [] means no tables. An img2table ExtractedTable
  is read from bbox and content: row -> cells with bbox.{x1,y1,x2,y2} and
  value. Identical bbox+text repeated across a rectangle becomes one cell with
  rowSpan and columnSpan, which is how img2table 2.0 represents a merge.
  A dict table may instead pass explicit cells with row, column, rowSpan, and
  columnSpan. Absent spans mean 1. Cell confidence stays null unless the
  injected cell carries a finite confidence. title is kept when it is a string.

Default engines are constructed on the first recognize() for that language,
never at import. Line OCR is rapidocr.RapidOCR 3.10: Rec PP-OCRv5 mobile,
lang en or korean, Global.text_score 0, and the call also passes text_score=0
so low scores are not dropped by RapidOCR's filter. Det and cls stay the
package defaults. ONNX Runtime intra_op_num_threads and inter_op_num_threads
are 1. Tables use img2table 2.0 Image(src=png, detect_rotation=False) and
img2table.ocr.RapidOCR with the same params, then extract_tables(
implicit_rows=True, implicit_columns=True, borderless_tables=True,
min_confidence=1, max_workers=1). min_confidence cannot be 0: img2table 2.0
validate_positive_int rejects values below 1.

On that default path only, a majority of line boxes taller than they are wide
rotates the PNG 90 degrees clockwise with PIL and runs lines and tables on
the rotated image. Polygons, line boxes, and cell boxes are mapped back onto
the input pixels. The recorded transform is op page-rotate, angle 90,
direction clockwise, coordinateSpace original. A point (x, y) on the rotated
image maps to (y, height - x) on the input, where height is the input height.
The existing 0/180 classifier then votes on horizontal line crops. A confident
upside-down majority triggers a 180-degree page correction before table parsing,
so the cell grid and line order are upright as well as the recognized words.
Injected engines receive the original bytes and are not rotated. image.sha256
is the sha256 of the input bytes. If PIL cannot rotate, the unrotated result
is kept and page-rotate-unavailable is recorded.

Accepted language values are en, ko, and korean. Anything else is
language-unsupported and does not run an engine. There is no language
detection. Limits: PNG bytes only, encoded size at most 30 MiB
(30 * 1024 * 1024), and at most 12_000_000 pixels from IHDR.
"""
import hashlib
import io
import math
import threading

SCHEMA = 'falsify.ocr-page.v1'
RAPIDOCR_VERSION = '3.10.0'
IMG2TABLE_VERSION = '2.0.0'
MAX_ENCODED_BYTES = 30 * 1024 * 1024
MAX_PIXELS = 12_000_000
MIN_TABLE_CONFIDENCE = 1
_PNG = b'\x89PNG\r\n\x1a\n'
_EXPECTED = {'rapidocr': RAPIDOCR_VERSION, 'img2table': IMG2TABLE_VERSION}
_MODEL = {'en': 'en_PP-OCRv5_rec_mobile', 'ko': 'korean_PP-OCRv5_rec_mobile'}
_LINE_ENGINES = {}
_TABLE_ENGINES = {}
_CACHE_LOCK = threading.Lock()


def recognize(png_bytes, language='en', engine=None, table_engine=None):
    if not isinstance(png_bytes, (bytes, bytearray)):
        return _envelope('unavailable', _image(None, None, None), _language_echo(language),
            [], [], [], _provenance(False, False, None, {}), ['input-type'])
    data = bytes(png_bytes)
    if len(data) > MAX_ENCODED_BYTES:
        return _envelope('unavailable', _image(None, None, None), _language_echo(language),
            [], [], [], _provenance(False, False, None, {}), ['encoded-size'])
    digest = hashlib.sha256(data).hexdigest()
    gate, width, height = _png_geometry(data)
    image = _image(digest, width, height)
    if gate:
        return _envelope('unavailable', image, _language_echo(language), [], [], [],
            _provenance(False, False, None, {}), [gate])
    if width * height > MAX_PIXELS:
        return _envelope('unavailable', image, _language_echo(language), [], [], [],
            _provenance(False, False, None, {}), ['pixel-count'])
    lang = _normalize_language(language)
    if lang is None:
        return _envelope('unavailable', image, _language_echo(language), [], [], [],
            _provenance(False, False, None, {}), ['language-unsupported'])

    issues = []
    versions = {}
    line_default = engine is None
    table_default = table_engine is None
    if line_default and table_default:
        line_ok, lines, line_transforms, table_ok, tables, table_transforms = _default_page(
            data, lang, height, issues, versions)
    else:
        line_ok, lines, line_transforms = _lines(data, lang, engine, issues, versions)
        table_ok, tables, table_transforms = _tables(data, lang, table_engine, issues, versions)
    transforms = line_transforms + table_transforms
    status = 'ready'
    if not line_ok and not table_ok:
        status = 'unavailable'
    elif issues or not line_ok or not table_ok:
        status = 'partial'
    return _envelope(status, image, lang, lines, tables, transforms,
        _provenance(line_default, table_default, lang, versions), issues)


def _lines(data, language, engine, issues, versions):
    if engine is None:
        return _default_lines(data, language, issues, versions)
    try:
        raw = _invoke(engine, data, ('recognize',))
    except Exception as exc:
        _add(issues, f'line-engine:{type(exc).__name__}')
        return False, [], []
    parsed, transforms = _parse_lines(raw, issues)
    if parsed is None:
        return False, [], []
    return True, parsed, transforms


def _tables(data, language, engine, issues, versions):
    if engine is None:
        return _default_tables(data, language, issues, versions)
    try:
        raw = _invoke(engine, data, ('extract_tables', 'extract'))
    except Exception as exc:
        _add(issues, f'table-engine:{type(exc).__name__}')
        return False, [], []
    parsed = _parse_tables(raw, issues)
    if parsed is None:
        return False, [], []
    return True, parsed, _transforms_from(raw, issues)


def _default_lines(data, language, issues, versions):
    try:
        import rapidocr
    except ModuleNotFoundError:
        _add(issues, 'rapidocr-missing')
        return False, [], []
    _note_version(issues, versions, 'rapidocr')
    try:
        options={'return_word_box':True,'return_single_char_box':True} if language=='ko' else {}
        raw = _line_engine(language, rapidocr)(data, text_score=0.0,**options)
    except Exception as exc:
        _add(issues, f'line-engine:{type(exc).__name__}')
        return False, [], []
    parsed, transforms = _parse_lines(raw, issues)
    if parsed is None:
        return False, [], []
    if language=='ko':
        from paper_ocr_spacing import present
        words=getattr(raw,'word_results',None)
        for line in parsed:
            tokens=[]
            index=int(line['id'].split('-')[-1])
            if words is not None and index<len(words):
                for text,score,polygon in words[index]:
                    points=polygon.tolist() if hasattr(polygon,'tolist') else polygon
                    _,box,_=_geometry(points)
                    if box:tokens.append({'text':text,'confidence':float(score),'bbox':list(box),'polygon':points})
            line['tokens']=tokens
            line.update(present(line['text'],tokens))
    return True, parsed, transforms


def _default_tables(data, language, issues, versions):
    try:
        import rapidocr
        from img2table.document import Image
    except ModuleNotFoundError as exc:
        _add(issues, _missing_package(exc))
        return False, [], []
    _note_version(issues, versions, 'rapidocr')
    _note_version(issues, versions, 'img2table')
    try:
        image = Image(src=data, detect_rotation=False)
        raw = image.extract_tables(
            ocr=_table_engine(language, rapidocr),
            implicit_rows=True,
            implicit_columns=True,
            borderless_tables=True,
            min_confidence=MIN_TABLE_CONFIDENCE,
            max_workers=1,
        )
    except Exception as exc:
        _add(issues, f'table-engine:{type(exc).__name__}')
        return False, [], []
    parsed = _parse_tables(raw, issues)
    if parsed is None:
        return False, [], []
    return True, parsed, []


def _default_page(data, language, height, issues, versions):
    line_issues = []
    line_ok, lines, line_transforms = _default_lines(data, language, line_issues, versions)
    ocr_bytes = data
    if line_ok and _majority_vertical(lines):
        turned = _rotate_png_90_cw(data)
        if turned is None:
            _add(line_issues, 'page-rotate-unavailable')
        else:
            turned_issues = []
            turned_ok, turned_lines, _turned_transforms = _default_lines(
                turned, language, turned_issues, versions)
            if turned_ok and turned_lines and not _majority_vertical(turned_lines):
                ocr_bytes = turned
                lines = _remap_lines(turned_lines, height)
                line_transforms = [_page_rotation_record()]
                line_issues = _kept_engine_meta(line_issues) + [
                    code for code in turned_issues if not _engine_meta(code)]
    for code in line_issues:
        _add(issues, code)
    sideways = ocr_bytes is not data
    working_lines = turned_lines if sideways else lines
    flipped = False
    _, work_width, work_height = _png_geometry(ocr_bytes)
    if _upside_down(ocr_bytes, working_lines, language):
        upright = _rotate_png_180(ocr_bytes)
        if upright is not None:
            more_issues = []
            ok, upright_lines, _ = _default_lines(upright, language, more_issues, versions)
            if ok and upright_lines:
                flipped = True; ocr_bytes = upright
                lines = _flip_records(upright_lines, work_width, work_height)
                if sideways: lines = _remap_lines(lines, height)
                line_transforms.append({'op':'page-rotate','angle':180,'direction':'clockwise',
                    'coordinateSpace':'after-page-rotate' if sideways else 'original'})
                for code in more_issues: _add(issues, code)
    table_ok, tables, table_transforms = _default_tables(ocr_bytes, language, issues, versions)
    if flipped:
        tables = _flip_records(tables, work_width, work_height)
    if sideways:
        tables = _remap_tables(tables, height)
    return line_ok, lines, line_transforms, table_ok, tables, table_transforms


def _upside_down(data, lines, language):
    """Use the existing 0/180 classifier on readable horizontal line crops.

    OCR itself corrects 180-degree words, so recognition confidence cannot
    distinguish page orientation. Preserve its classifier's independent vote.
    """
    candidates = [line for line in lines if len(line.get('text','')) >= 3 and
        line['bbox'][2]-line['bbox'][0] > 1.5*(line['bbox'][3]-line['bbox'][1])][:16]
    if len(candidates) < 3: return False
    try:
        import numpy as np
        import rapidocr
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            crops = [np.array(image.convert('RGB').crop(tuple(line['bbox'])))[:, :, ::-1].copy() for line in candidates]
        engine = _line_engine(language, rapidocr)
        _, result = engine.cls_and_rotate(crops)
        votes = [label for label, score in result.cls_res if float(score) >= 0.90]
        return len(votes) >= 3 and sum(label == '180' for label in votes)*2 > len(votes)
    except (ImportError, AttributeError, ValueError, OSError, TypeError):
        return False


def _rotate_png_180(data):
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            out = io.BytesIO(); image.transpose(Image.Transpose.ROTATE_180).save(out,format='PNG')
            return out.getvalue()
    except (ImportError, OSError, ValueError): return None


def _flip_records(records, width, height):
    def box(value): return [width-value[2],height-value[3],width-value[0],height-value[1]] if value else value
    out = []
    for entry in records:
        item = dict(entry); item['bbox'] = box(item.get('bbox'))
        if 'polygon' in item: item['polygon'] = [[width-x,height-y] for x,y in item['polygon']]
        if 'cells' in item: item['cells'] = _flip_records(item['cells'],width,height)
        if 'tokens' in item: item['tokens'] = _flip_records(item['tokens'],width,height)
        out.append(item)
    return out


def _majority_vertical(lines):
    votes = []
    for line in lines:
        bbox = line.get('bbox')
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in bbox):
            continue
        box_width = abs(bbox[2] - bbox[0])
        box_height = abs(bbox[3] - bbox[1])
        if box_width == 0 and box_height == 0:
            continue
        votes.append(box_height > box_width)
    if not votes:
        return False
    return sum(votes) * 2 > len(votes)


def _rotate_png_90_cw(data):
    try:
        from PIL import Image
    except ModuleNotFoundError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            turned = image.transpose(Image.Transpose.ROTATE_270)
            buffer = io.BytesIO()
            turned.save(buffer, format='PNG')
        return buffer.getvalue()
    except Exception:
        return None


def _page_rotation_record():
    return {
        'op': 'page-rotate',
        'angle': 90,
        'direction': 'clockwise',
        'coordinateSpace': 'original',
    }


def _engine_meta(code):
    return code.endswith('-missing') or '-version:' in code


def _kept_engine_meta(codes):
    return [code for code in codes if _engine_meta(code)]


def _remap_lines(lines, height):
    remapped = []
    for line in lines:
        item = dict(line)
        item['bbox'] = _unmap_box(line.get('bbox'), height)
        if 'polygon' in line:
            item['polygon'] = _unmap_polygon(line.get('polygon'), height)
        if 'tokens' in line:item['tokens']=_remap_lines(line['tokens'],height)
        remapped.append(item)
    return remapped


def _remap_tables(tables, height):
    remapped = []
    for table in tables:
        item = dict(table)
        item['bbox'] = _unmap_box(table.get('bbox'), height)
        item['cells'] = [_remap_cell(cell, height) for cell in table.get('cells') or []]
        remapped.append(item)
    return remapped


def _remap_cell(cell, height):
    item = dict(cell)
    item['bbox'] = _unmap_box(cell.get('bbox'), height)
    return item


def _unmap_box(bbox, height):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return bbox
    corners = (
        (bbox[0], bbox[1]),
        (bbox[2], bbox[1]),
        (bbox[2], bbox[3]),
        (bbox[0], bbox[3]),
    )
    mapped = [_unmap_cw90(x, y, height) for x, y in corners]
    xs = [point[0] for point in mapped]
    ys = [point[1] for point in mapped]
    return [_json_num(min(xs)), _json_num(min(ys)), _json_num(max(xs)), _json_num(max(ys))]


def _unmap_polygon(polygon, height):
    if not polygon:
        return polygon
    mapped = []
    for point in polygon:
        x, y = _unmap_cw90(point[0], point[1], height)
        mapped.append([_json_num(x), _json_num(y)])
    return mapped


def _unmap_cw90(x, y, height):
    """Map a point on the 90-degree clockwise image back to the input image."""
    return y, height - x


def _rapidocr_params(language, rapidocr):
    rec_lang = rapidocr.LangRec.EN if language == 'en' else rapidocr.LangRec.KOREAN
    return {
        'Global.text_score': 0.0,
        'Global.log_level': 'critical',
        'EngineConfig.onnxruntime.intra_op_num_threads': 1,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
        'Det.engine_type': rapidocr.EngineType.ONNXRUNTIME,
        'Cls.engine_type': rapidocr.EngineType.ONNXRUNTIME,
        'Rec.engine_type': rapidocr.EngineType.ONNXRUNTIME,
        'Rec.lang_type': rec_lang,
        'Rec.model_type': rapidocr.ModelType.MOBILE,
        'Rec.ocr_version': rapidocr.OCRVersion.PPOCRV5,
    }


def _line_engine(language, rapidocr):
    with _CACHE_LOCK:
        engine = _LINE_ENGINES.get(language)
        if engine is None:
            engine = rapidocr.RapidOCR(params=_rapidocr_params(language, rapidocr))
            _LINE_ENGINES[language] = engine
        return engine


def _table_engine(language, rapidocr):
    with _CACHE_LOCK:
        engine = _TABLE_ENGINES.get(language)
        if engine is None:
            from img2table.ocr import RapidOCR
            engine = RapidOCR(params=_rapidocr_params(language, rapidocr))
            _TABLE_ENGINES[language] = engine
        return engine


def _invoke(engine, data, names):
    if callable(engine):
        return engine(data)
    for name in names:
        method = getattr(engine, name, None)
        if callable(method):
            return method(data)
    raise TypeError('engine')


def _parse_lines(raw, issues):
    if raw is None:
        return [], []
    transforms = _transforms_from(raw, issues)
    records = _line_records(raw)
    if records is None:
        fields = _ocr_fields(raw)
        if fields is None:
            _add(issues, 'line-result-type')
            return None, []
        boxes, txts, scores = fields
        count = max(len(boxes), len(txts), len(scores))
        if len(boxes) != count or len(txts) != count or len(scores) != count:
            _add(issues, 'line-field-mismatch')
        records = []
        for index in range(count):
            record = {
                'text': txts[index] if index < len(txts) else None,
                'box': boxes[index] if index < len(boxes) else None,
            }
            if index < len(scores):
                record['confidence'] = scores[index]
            records.append(record)
    lines = []
    for index, record in enumerate(records):
        text = _text(record.get('text'), issues, 'line-text-type')
        confidence = _confidence(record.get('confidence'), issues, 'confidence' in record)
        if 'polygon' in record:
            raw_geometry = record.get('polygon')
        else:
            raw_geometry = record.get('bbox', record.get('box'))
        polygon, bbox, bad_box = _geometry(raw_geometry)
        if bad_box:
            _add(issues, 'line-bbox-invalid')
        line = {
            'id': f'line-{index}',
            'text': text,
            'confidence': confidence,
            'bbox': _json_box(bbox),
        }
        if polygon is not None:
            line['polygon'] = polygon
        if 'angle' in record:
            angle = _num(record.get('angle'))
            if angle is None:
                _add(issues, 'transform-type')
            else:
                transforms.append({
                    'op': 'textline-orientation',
                    'angle': _json_num(angle),
                    'lineId': line['id'],
                    'coordinateSpace': 'original',
                })
        lines.append(line)
    return lines, transforms


def _line_records(raw):
    if isinstance(raw, (list, tuple)):
        if all(isinstance(item, dict) for item in raw):
            return list(raw)
        return None
    if isinstance(raw, dict) and 'lines' in raw:
        lines = raw['lines']
        if isinstance(lines, (list, tuple)) and all(isinstance(item, dict) for item in lines):
            return list(lines)
        return None
    lines = getattr(raw, 'lines', None)
    if isinstance(lines, (list, tuple)) and all(isinstance(item, dict) for item in lines):
        return list(lines)
    return None


def _ocr_fields(raw):
    found = False
    sequences = []
    for name in ('boxes', 'txts', 'scores'):
        present, value = _field(raw, name)
        found = found or present
        if not present or value is None:
            sequences.append([])
            continue
        sequence = _sequence(value)
        if sequence is None:
            return None
        sequences.append(sequence)
    if not found:
        return None
    return tuple(sequences)


def _field(raw, name):
    if isinstance(raw, dict):
        return name in raw, raw.get(name)
    return hasattr(raw, name), getattr(raw, name, None)


def _parse_tables(raw, issues):
    if raw is None:
        return []
    if isinstance(raw, (str, bytes)):
        _add(issues, 'table-result-type')
        return None
    tables = list(raw) if isinstance(raw, (list, tuple)) else [raw]
    parsed = []
    failed = False
    for table in tables:
        item = _parse_table(table, issues)
        if item is None:
            failed = True
        else:
            parsed.append(item)
    if failed and not parsed:
        return None
    return parsed


def _parse_table(table, issues):
    if isinstance(table, dict) and 'cells' in table:
        return _explicit_table(table, issues)
    content = table.get('content') if isinstance(table, dict) else getattr(table, 'content', None)
    if content is None:
        _add(issues, 'table-result-type')
        return None
    grid, row_count, column_count = _grid(content, issues)
    cells = _cells_from_grid(grid, issues)
    bbox = _table_bbox(table, cells, issues)
    return {
        'bbox': bbox,
        'rows': row_count,
        'columns': column_count,
        'title': _title(table, issues),
        'cells': cells,
    }


def _explicit_table(table, issues):
    cells_in = table.get('cells')
    if not isinstance(cells_in, (list, tuple)):
        _add(issues, 'table-result-type')
        return None
    cells = []
    for item in cells_in:
        if not isinstance(item, dict):
            _add(issues, 'table-result-type')
            continue
        row, column = item.get('row'), item.get('column')
        if not _index(row) or not _index(column):
            _add(issues, 'table-cell-index')
            continue
        row_span = _span(item, 'rowSpan', issues)
        column_span = _span(item, 'columnSpan', issues)
        polygon, bbox, bad_box = _geometry(item.get('bbox'))
        if bad_box:
            _add(issues, 'cell-bbox-invalid')
        cells.append({
            'row': row,
            'column': column,
            'rowSpan': row_span,
            'columnSpan': column_span,
            'text': _text(item['text'], issues, 'cell-text-type') if 'text' in item else None,
            'bbox': bbox,
            'confidence': _confidence(item['confidence'], issues, True) if 'confidence' in item else None,
        })
    rows = table.get('rows')
    columns = table.get('columns')
    needed_rows = _extent(cells, 'row', 'rowSpan')
    needed_columns = _extent(cells, 'column', 'columnSpan')
    rows = _declared_count(rows, needed_rows, issues)
    columns = _declared_count(columns, needed_columns, issues)
    cells.sort(key=lambda cell: (cell['row'], cell['column']))
    return {
        'bbox': _table_bbox(table, cells, issues),
        'rows': rows,
        'columns': columns,
        'title': _title(table, issues),
        'cells': cells,
    }


def _grid(content, issues):
    rows = {}
    if isinstance(content, dict):
        pairs = content.items()
    elif isinstance(content, (list, tuple)):
        pairs = enumerate(content)
    else:
        _add(issues, 'table-result-type')
        return [], 0, 0
    for key, row in pairs:
        if not _index(key):
            _add(issues, 'table-row-index')
            continue
        if not isinstance(row, (list, tuple)):
            _add(issues, 'table-result-type')
            continue
        rows[key] = list(row)
    if not rows:
        return [], 0, 0
    height = max(rows) + 1
    width = max(len(row) for row in rows.values())
    grid = [[None for _ in range(width)] for _ in range(height)]
    for index in range(height):
        row = rows.get(index)
        if row is None:
            _add(issues, 'table-cell-missing')
            continue
        for column, cell in enumerate(row):
            grid[index][column] = cell
        if len(row) < width:
            _add(issues, 'table-cell-missing')
    return grid, height, width


def _cells_from_grid(grid, issues):
    groups = {}
    for row_index, row in enumerate(grid):
        for column, cell in enumerate(row):
            if cell is None:
                _add(issues, 'table-cell-missing')
                continue
            bbox = _object_bbox(cell, issues)
            text = _text(_cell_value(cell), issues, 'cell-text-type')
            confidence = _confidence(_cell_confidence(cell), issues, _has_confidence(cell))
            key = (id(cell), text) if bbox is None else (_bbox_key(bbox), text)
            groups.setdefault(key, []).append((row_index, column, bbox, text, confidence))
    cells = []
    for members in groups.values():
        positions = {(item[0], item[1]) for item in members}
        rows = [item[0] for item in members]
        cols = [item[1] for item in members]
        rectangular = (
            len(positions) == len(members)
            and len(positions) == (max(rows) - min(rows) + 1) * (max(cols) - min(cols) + 1)
        )
        if not rectangular:
            _add(issues, 'table-span-nonrectangular')
            for row_index, column, bbox, text, confidence in members:
                cells.append(_cell(row_index, column, 1, 1, text, bbox, confidence))
            continue
        confidence = _one_confidence([item[4] for item in members], issues)
        cells.append(_cell(min(rows), min(cols), max(rows) - min(rows) + 1,
            max(cols) - min(cols) + 1, members[0][3], members[0][2], confidence))
    cells.sort(key=lambda cell: (cell['row'], cell['column']))
    return cells


def _cell(row, column, row_span, column_span, text, bbox, confidence):
    return {
        'row': row,
        'column': column,
        'rowSpan': row_span,
        'columnSpan': column_span,
        'text': text,
        'bbox': None if bbox is None else [_json_num(value) for value in bbox],
        'confidence': confidence,
    }


def _object_bbox(cell, issues):
    raw = cell.get('bbox') if isinstance(cell, dict) else getattr(cell, 'bbox', None)
    _polygon, bbox, bad = _geometry(raw)
    if bad:
        _add(issues, 'cell-bbox-invalid')
    return bbox


def _json_box(bbox):
    if bbox is None:
        return None
    return [_json_num(value) for value in bbox]


def _cell_value(cell):
    if isinstance(cell, dict):
        return cell.get('value', cell.get('text'))
    if hasattr(cell, 'value'):
        return cell.value
    return getattr(cell, 'text', None)


def _has_confidence(cell):
    if isinstance(cell, dict):
        return 'confidence' in cell
    return hasattr(cell, 'confidence')


def _cell_confidence(cell):
    if isinstance(cell, dict):
        return cell.get('confidence')
    return getattr(cell, 'confidence', None)


def _one_confidence(values, issues):
    finite = [value for value in values if value is not None]
    if len(set(finite)) > 1:
        _add(issues, 'cell-confidence-conflict')
        return None
    return finite[0] if finite else None


def _table_bbox(table, cells, issues):
    raw = table.get('bbox') if isinstance(table, dict) else getattr(table, 'bbox', None)
    _polygon, bbox, bad = _geometry(raw)
    if bad:
        _add(issues, 'table-bbox-invalid')
    if bbox is not None:
        return [_json_num(value) for value in bbox]
    boxes = [cell['bbox'] for cell in cells if cell.get('bbox')]
    if not boxes:
        _add(issues, 'table-bbox-unknown')
        return None
    return [
        _json_num(min(box[0] for box in boxes)),
        _json_num(min(box[1] for box in boxes)),
        _json_num(max(box[2] for box in boxes)),
        _json_num(max(box[3] for box in boxes)),
    ]


def _title(table, issues):
    raw = table.get('title') if isinstance(table, dict) else getattr(table, 'title', None)
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw
    _add(issues, 'table-title-type')
    return None


def _geometry(raw):
    if raw is None:
        return None, None, False
    points = _points(raw)
    if points:
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        return [[_json_num(point[0]), _json_num(point[1])] for point in points], (
            min(xs), min(ys), max(xs), max(ys)), False
    box = _xyxy(raw)
    if box is not None:
        return None, box, False
    named = _named_box(raw)
    if named is not None:
        return None, named, False
    return None, None, True


def _points(raw):
    if isinstance(raw, (str, bytes, dict)) or raw is None:
        return None
    try:
        points = []
        for point in raw:
            if isinstance(point, (str, bytes)) or not hasattr(point, '__iter__'):
                return None
            pair = list(point)
            if len(pair) < 2:
                return None
            x, y = _num(pair[0]), _num(pair[1])
            if x is None or y is None:
                return None
            points.append((x, y))
    except TypeError:
        return None
    if len(points) < 3:
        return None
    return points


def _xyxy(raw):
    if isinstance(raw, (str, bytes, dict)) or not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    numbers = [_num(value) for value in raw]
    if any(number is None for number in numbers):
        return None
    return tuple(numbers)


def _named_box(raw):
    if raw is None or isinstance(raw, (str, bytes, list, tuple)):
        return None
    if isinstance(raw, dict):
        values = [raw.get(name) for name in ('x1', 'y1', 'x2', 'y2')]
    else:
        values = [getattr(raw, name, None) for name in ('x1', 'y1', 'x2', 'y2')]
    numbers = [_num(value) for value in values]
    if any(number is None for number in numbers):
        return None
    return tuple(numbers)


def _png_geometry(data):
    if len(data) < 8 or data[:8] != _PNG:
        return 'png-only', None, None
    pos = 8
    width = height = None
    seen_iend = False
    while pos + 12 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], 'big')
        kind = data[pos + 4:pos + 8]
        if pos + 12 + length > len(data):
            return 'png-invalid', width, height
        payload = data[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            if length != 13 or width is not None:
                return 'png-invalid', None, None
            width = int.from_bytes(payload[0:4], 'big')
            height = int.from_bytes(payload[4:8], 'big')
            if width <= 0 or height <= 0:
                return 'png-invalid', width, height
        if kind == b'IEND':
            seen_iend = True
            break
        pos += 12 + length
    if width is None or not seen_iend:
        return 'png-invalid', width, height
    return None, width, height


def _normalize_language(language):
    if language == 'en':
        return 'en'
    if language in ('ko', 'korean'):
        return 'ko'
    return None


def _language_echo(language):
    return language if isinstance(language, str) else None


def _distribution_version(name):
    from importlib.metadata import PackageNotFoundError, version
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _note_version(issues, versions, dist):
    if dist in versions:
        return
    actual = _distribution_version(dist)
    versions[dist] = actual
    if actual is None:
        _add(issues, f'{dist}-version:unknown')
    elif actual != _EXPECTED[dist]:
        _add(issues, f'{dist}-version:{actual}')


def _missing_package(exc):
    name = exc.name or ''
    if name.startswith('img2table'):
        return 'img2table-missing'
    return 'rapidocr-missing'


def _provenance(line_default, table_default, language, versions):
    if not line_default and not table_default:
        engine, method, version, model = 'injected', 'injected', 'injected', None
    else:
        line = 'rapidocr' if line_default else 'injected'
        table = 'img2table' if table_default else 'injected'
        engine = 'rapidocr+img2table' if line_default and table_default else f'{line}+{table}'
        method = (
            'rapidocr Rec PP-OCRv5 mobile text_score=0 onnxruntime threads=1; '
            'det/cls=RapidOCR defaults; '
            'img2table implicit_rows=true implicit_columns=true borderless_tables=true '
            'min_confidence=1 max_workers=1 detect_rotation=false; '
            'page_rotate=90 clockwise when a majority of line boxes are vertical, '
            'boxes mapped to the input image'
        )
        if not line_default or not table_default:
            method = f'{line}+{table}; {method}'
        parts = []
        for dist in ('rapidocr', 'img2table'):
            if dist in versions:
                actual = versions[dist] if versions[dist] is not None else 'unknown'
                parts.append(f'{dist}=={actual}')
        version = ','.join(parts) if parts else 'unavailable'
        model = _MODEL.get(language)
    return {
        'engine': engine,
        'version': version,
        'method': method,
        'model': model,
        'language': language,
    }


def _envelope(status, image, language, lines, tables, transforms, provenance, issues):
    return {
        'schema': SCHEMA,
        'status': status,
        'image': image,
        'language': language,
        'lines': lines,
        'tables': tables,
        'transforms': transforms,
        'provenance': provenance,
        'issues': issues,
    }


def _image(digest, width, height):
    return {'sha256': digest, 'width': width, 'height': height}


def _sequence(value):
    if value is None:
        return None
    if isinstance(value, (str, bytes, dict)):
        return None
    try:
        return list(value)
    except TypeError:
        return None


def _text(value, issues, code):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    _add(issues, code)
    return None


def _confidence(value, issues, present):
    if not present or value is None:
        return None
    if isinstance(value, bool):
        _add(issues, 'confidence-type')
        return None
    number = _num(value)
    if number is None:
        if isinstance(value, (int, float)) or hasattr(value, 'item'):
            _add(issues, 'nonfinite-confidence')
        else:
            _add(issues, 'confidence-type')
        return None
    return _json_num(number)


def _num(value):
    if isinstance(value, bool) or value is None:
        return None
    if hasattr(value, 'item') and not isinstance(value, (int, float, str, bytes)):
        try:
            value = value.item()
        except Exception:
            return None
        return _num(value)
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def _json_num(value):
    number = float(value)
    if number.is_integer() and abs(number) < 2**53:
        return int(number)
    return number


def _index(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _span(item, name, issues):
    if name not in item:
        return 1
    value = item[name]
    if _index(value) and value >= 1:
        return value
    _add(issues, 'table-span-invalid')
    return None


def _extent(cells, index_name, span_name):
    extent = 0
    for cell in cells:
        span = cell[span_name]
        if span is None:
            continue
        extent = max(extent, cell[index_name] + span)
    return extent


def _declared_count(value, needed, issues):
    if value is None:
        return needed
    if not _index(value):
        _add(issues, 'table-shape')
        return needed
    if value < needed:
        _add(issues, 'table-shape')
        return needed
    return value


def _bbox_key(bbox):
    if bbox is None:
        return None
    return tuple(_json_num(value) for value in bbox)


def _transforms_from(raw, issues):
    if isinstance(raw, (list, tuple)) or raw is None:
        return []
    raw_list = raw.get('transforms') if isinstance(raw, dict) else getattr(raw, 'transforms', None)
    if raw_list is None:
        return []
    if isinstance(raw_list, (str, bytes)) or not isinstance(raw_list, (list, tuple)):
        _add(issues, 'transform-type')
        return []
    cleaned = []
    for item in raw_list:
        if not isinstance(item, dict) or not isinstance(item.get('op'), str) or not item['op']:
            _add(issues, 'transform-type')
            continue
        record = {'op': item['op']}
        if 'angle' in item:
            angle = _num(item.get('angle'))
            if angle is None:
                _add(issues, 'transform-type')
                continue
            record['angle'] = _json_num(angle)
        for key in ('lineId', 'coordinateSpace'):
            if isinstance(item.get(key), str):
                record[key] = item[key]
        if record.get('coordinateSpace') not in (None, 'original'):
            _add(issues, 'transform-coordinate-space')
        cleaned.append(record)
    return cleaned


def _add(issues, code):
    if code not in issues:
        issues.append(code)
