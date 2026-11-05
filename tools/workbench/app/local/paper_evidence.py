"""In-memory paper evidence: raw table cells and figure crops from the source PDF.

Public API:
  EvidenceStore(ttl_seconds=43200, max_documents=4)
  default_store = EvidenceStore()
  prepare(pdf_bytes, file_hash) -> summary
  status(paper_id) -> summary
  list_items(paper_id, kind=None, page_index=None, offset=0, limit=50)
  read_item(paper_id, item_id)
  render_region(paper_id, page_index, bbox=None, dpi=120)

Summary keys: schema ('falsify.paper-evidence.v1'), paperId, fileHash, status
('ready'|'partial'), pageCount, counts {tables, figures}, engine, limitations, expiresAt.
Item metadata: id, type ('table'|'figure'), pageIndex, bbox [x0,y0,x1,y1] in MuPDF
page.rect points, caption, provenance. read_item on a table also returns
table {rows, columns, cells:[{row, column, rowSpan, columnSpan, text, bbox, header}]}.
header is true/false only when PyMuPDF's own header box covers that cell; otherwise null.
Cell text is the engine string, uncorrected. Captions are a label heuristic.

No disk persistence. The caller's bytes are copied and never written back. Docling is not
used. Vector drawings are not figures: there is no vector-figure detector here.
Rotated pages are read at rotation 0 (where find_tables keeps cell text) and every bbox
is mapped back through the page rotation matrix into page.rect, which is also the space
render_region clips. CropBox and a shifted MediaBox are reported, not treated as the
unshifted media rectangle. ValueError args[0] is a fixed code. Unknown or expired ids
raise KeyError.
"""
import base64
import copy
import hashlib
import math
import re
import secrets
import threading
import time
from datetime import datetime, timezone

import pymupdf

pymupdf.no_recommend_layout()

SCHEMA = 'falsify.paper-evidence.v1'
ENGINE = 'pymupdf'
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_PAGES = 2000
MAX_TABLES_PER_PAGE = 40
MAX_FIGURES_PER_PAGE = 40
MAX_CELLS = 500
MAX_ITEMS = 500
MAX_PIXELS = 2_000_000
MAX_DPI = 9600
LIST_LIMIT = 200
ORIGIN_TOLERANCE = 0.01
EDGE_TOLERANCE = 0.5
CAPTION_ABOVE = 48.0
CAPTION_BELOW = 64.0
_HEX = re.compile(r'[0-9a-f]{64}\Z')
_LABEL = re.compile(r'^\s*(table|figure|fig\.?|표|그림)\b', re.IGNORECASE)
_KINDS = ('table', 'figure')


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _matrix(page):
    m = page.rotation_matrix
    return pymupdf.Matrix(m.a, m.b, m.c, m.d, m.e, m.f)


def _cropped_or_offset(page):
    """True when CropBox is not the MediaBox at the origin. Rotation is separate."""
    media, crop, pos = page.mediabox, page.cropbox, page.cropbox_position
    near = lambda a, b: abs(a - b) <= ORIGIN_TOLERANCE
    return not (near(media.x0, 0) and near(media.y0, 0) and near(pos.x, 0) and near(pos.y, 0)
        and near(crop.width, media.width) and near(crop.height, media.height))


def _round_box(box):
    rect = pymupdf.Rect(box)
    if rect.is_empty or rect.is_infinite:
        return None
    return [round(rect.x0, 3), round(rect.y0, 3), round(rect.x1, 3), round(rect.y1, 3)]


def _map_box(box, matrix):
    return _round_box(pymupdf.Rect(box) * matrix)


def _find_tables(page):
    return page.find_tables()


def _edge(grid, index, axis):
    values = []
    for r, row in enumerate(grid):
        for c, cell in enumerate(row):
            if cell is None:
                continue
            if axis == 'x' and c == index:
                values.append(cell[0])
            elif axis == 'y' and r == index:
                values.append(cell[1])
    return min(values) if values else None


def _col_span(grid, r, c, box):
    span = 1
    while c + span < len(grid[r]) and grid[r][c + span] is None:
        left = _edge(grid, c + span, 'x')
        if left is None or left >= box[2] - EDGE_TOLERANCE:
            break
        span += 1
    return span


def _row_span(grid, r, c, box, col_span):
    span = 1
    while r + span < len(grid):
        row = grid[r + span]
        if any(c + dc >= len(row) or row[c + dc] is not None for dc in range(col_span)):
            break
        top = _edge(grid, r + span, 'y')
        if top is None or top >= box[3] - EDGE_TOLERANCE:
            break
        span += 1
    return span


def _cell_text(extract, r, c):
    try:
        value = extract[r][c]
    except (IndexError, TypeError):
        return ''
    return value if isinstance(value, str) else ''


def _header_flags(table, placed):
    """True/false when the engine header box actually covers a cell; else null (unknown)."""
    unknown = {(r, c): None for r, c, _box in placed}
    header = getattr(table, 'header', None)
    if header is None or getattr(header, 'external', False) or getattr(header, 'bbox', None) is None:
        return unknown
    try:
        header_box = pymupdf.Rect(header.bbox)
    except (TypeError, ValueError):
        return unknown
    flags, any_true = {}, False
    for r, c, box in placed:
        cell = pymupdf.Rect(box)
        area = cell.get_area()
        flags[(r, c)] = bool(area and (cell & header_box).get_area() / area >= 0.5)
        any_true = any_true or flags[(r, c)]
    return flags if any_true else unknown


def _table_cells(grid, placed, extract, headers):
    cells = []
    for r, c, box in placed:
        col_span = _col_span(grid, r, c, box)
        row_span = _row_span(grid, r, c, box, col_span)
        rounded = _round_box(box)
        if rounded is None:
            raise RuntimeError('bbox')
        cells.append({'row': r, 'column': c, 'rowSpan': row_span, 'columnSpan': col_span,
            'text': _cell_text(extract, r, c), 'bbox': rounded, 'header': headers[(r, c)]})
    return cells


def _table_grid(table):
    rows = table.rows
    grid = [[None if cell is None else tuple(float(v) for v in cell) for cell in row.cells] for row in rows]
    if not grid or not any(cell is not None for row in grid for cell in row):
        return None, None
    width = max(len(row) for row in grid)
    grid = [row + [None] * (width - len(row)) for row in grid]
    if len(grid) * width > MAX_CELLS:
        raise RuntimeError('cells')
    return grid, width


def _table_from_engine(table):
    grid, width = _table_grid(table)
    if grid is None: return None
    extract = table.extract()
    placed = [(r, c, cell) for r, row in enumerate(grid) for c, cell in enumerate(row) if cell is not None]
    headers = _header_flags(table, placed)
    cells = _table_cells(grid, placed, extract, headers)
    if not cells:
        return None
    return {'bbox': _round_box(pymupdf.Rect(table.bbox)) or _union(cell['bbox'] for cell in cells),
        'rows': len(grid), 'columns': width, 'cells': cells}


def _union(boxes):
    boxes = list(boxes)
    return [round(min(b[0] for b in boxes), 3), round(min(b[1] for b in boxes), 3),
        round(max(b[2] for b in boxes), 3), round(max(b[3] for b in boxes), 3)]


def _collect_tables(page):
    found = _find_tables(page)
    tables, failed = [], False
    for table in list(getattr(found, 'tables', None) or []):
        if len(tables) >= MAX_TABLES_PER_PAGE:
            failed = True
            break
        try:
            payload = _table_from_engine(table)
        except Exception:
            failed = True
            continue
        if payload:
            tables.append(payload)
    return tables, failed


def _collect_images(page):
    info = page.get_image_info() or []
    figures, seen, failed = [], set(), False
    for image in info:
        if len(figures) >= MAX_FIGURES_PER_PAGE:
            failed = True
            break
        box = _round_box(image.get('bbox'))
        if box is None:
            continue
        key = tuple(box)
        if key in seen:
            continue
        seen.add(key)
        figures.append({'bbox': box})
    return figures, failed


def _collect_lines(page):
    data = page.get_text('dict', flags=pymupdf.TEXT_MEDIABOX_CLIP) or {}
    lines = []
    for block in data.get('blocks', []):
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            text = ''.join(span.get('text', '') for span in line.get('spans', []))
            box = _round_box(line.get('bbox'))
            if text and box is not None:
                lines.append((box, text))
    return lines


def _center_inside(box, regions):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return any(region[0] <= cx <= region[2] and region[1] <= cy <= region[3] for region in regions)


def _caption_gap(line, item, kind):
    lx0, ly0, lx1, ly1 = line
    ix0, iy0, ix1, iy1 = item
    overlap = min(lx1, ix1) - max(lx0, ix0)
    if overlap <= 0 and not (ix0 - 24 <= lx0 <= ix1):
        return None
    above, below = iy0 - ly1, ly0 - iy1
    if -2 <= above <= CAPTION_ABOVE:
        return above + (0 if kind == 'table' else 6)
    if -2 <= below <= CAPTION_BELOW:
        return below + (0 if kind == 'figure' else 6)
    return None


def _attach_captions(items, lines):
    regions = [item['bbox'] for item in items if item['type'] == 'table']
    labels = []
    for box, text in lines:
        if len(text) > 240 or not _LABEL.match(text) or _center_inside(box, regions):
            continue
        labels.append((box, text[:-1] if text.endswith('\n') else text))
    pairs = []
    for i, item in enumerate(items):
        for j, (box, _text) in enumerate(labels):
            gap = _caption_gap(box, item['bbox'], item['type'])
            if gap is not None:
                pairs.append((gap, i, j))
    used_items, used_labels = set(), set()
    for _gap, i, j in sorted(pairs):
        if i in used_items or j in used_labels:
            continue
        items[i]['caption'] = labels[j][1]
        used_items.add(i)
        used_labels.add(j)


def _detect_page(page):
    """Tables, images and caption lines in unrotated page space, plus the matrix into page.rect."""
    rotation = page.rotation % 360
    matrix = _matrix(page)
    cropped = _cropped_or_offset(page)
    if rotation:
        page.set_rotation(0)
    try:
        try:
            tables, table_failed = _collect_tables(page)
        except Exception:
            tables, table_failed = [], True
        try:
            images, image_failed = _collect_images(page)
        except Exception:
            images, image_failed = [], True
        try:
            lines = _collect_lines(page)
            line_failed = False
        except Exception:
            lines, line_failed = [], True
    finally:
        if rotation:
            page.set_rotation(rotation)
    return {'tables': tables, 'images': images, 'lines': lines, 'matrix': matrix, 'rotation': rotation,
        'cropped': cropped, 'failed': table_failed or image_failed, 'line_failed': line_failed}


def _provenance(method, rotation, cropped, caption):
    return {'engine': ENGINE, 'version': pymupdf.version[0], 'method': method, 'coordinateSpace': 'page.rect',
        'rotation': rotation, 'croppedOrOffset': cropped, 'rotationNormalized': bool(rotation),
        'captionAssociation': 'label-heuristic' if caption else 'none', 'captionCertain': False}


def _new_id(existing, prefix=''):
    for _ in range(8):
        value = secrets.token_urlsafe(18) if not prefix else prefix + secrets.token_hex(8)
        if value not in existing:
            return value
    raise RuntimeError('id')


def _record_page_limitations(limitations, detected, index):
    if detected['failed']:
        limitations['failed'].append(index)
    if detected['line_failed']:
        limitations['lines'].append(index)
    if detected['rotation']:
        limitations['rotated'].append(index)
    if detected['cropped']:
        limitations['cropped'].append(index)


def _validate_clip_bbox(bbox, page):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4 or not all(
            type(v) in (int, float) and not isinstance(v, bool) and math.isfinite(v) for v in bbox):
        raise ValueError('bbox')
    if not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        raise ValueError('bbox')
    if bbox[0] < page[0] - 1 or bbox[1] < page[1] - 1 or bbox[2] > page[2] + 1 or bbox[3] > page[3] + 1:
        raise ValueError('bbox')


class EvidenceStore:
    def __init__(self, ttl_seconds=43200, max_documents=4, *, clock=None):
        if type(ttl_seconds) not in (int, float) or isinstance(ttl_seconds, bool) or not math.isfinite(ttl_seconds) or ttl_seconds < 0:
            raise ValueError('ttl')
        if type(max_documents) is not int or not 1 <= max_documents <= 32:
            raise ValueError('max_documents')
        self._ttl = float(ttl_seconds)
        self._max = max_documents
        self._clock = clock or time.time
        self._docs = {}
        self._by_hash = {}
        self._seq = 0
        self._lock = threading.Lock()

    def prepare(self, pdf_bytes, file_hash, *, cancelled=None):
        from paper_native_worker import budget, check
        deadline = budget()
        raw = self._validated_pdf(pdf_bytes, file_hash)
        with self._lock:
            check(deadline, cancelled)
            self._purge()
            current = self._docs.get(self._by_hash.get(file_hash))
            if current is not None:
                current['expires_at'] = self._clock() + self._ttl
                current['summary']['expiresAt'] = _iso(current['expires_at'])
                return copy.deepcopy(current['summary'])
        from paper_native_worker import run
        record = run('evidence_extract', [raw, file_hash], cancelled=cancelled, deadline=deadline)
        if record.get('file_hash') != file_hash or record.get('pdf') != raw:
            raise ValueError('native_output_invalid')
        with self._lock:
            check(deadline, cancelled)
            self._purge()
            current = self._docs.get(self._by_hash.get(file_hash))
            if current is not None:
                current['expires_at'] = self._clock() + self._ttl
                current['summary']['expiresAt'] = _iso(current['expires_at'])
                return copy.deepcopy(current['summary'])
            while len(self._docs) >= self._max:
                self._drop(min(self._docs, key=lambda pid: (self._docs[pid]['expires_at'], self._docs[pid]['seq'])))
            if record['paper_id'] in self._docs:
                raise RuntimeError('id')
            self._seq += 1
            record['seq'] = self._seq
            record['expires_at'] = self._clock() + self._ttl
            record['summary']['expiresAt'] = _iso(record['expires_at'])
            self._docs[record['paper_id']] = record
            self._by_hash[file_hash] = record['paper_id']
            return copy.deepcopy(record['summary'])

    def source_authority(self, paper_id, file_hash, raw):
        """Hold source authority across a bounded publication critical section."""
        from contextlib import contextmanager
        @contextmanager
        def authority():
            with self._lock:
                record = self._live(paper_id)
                if record['file_hash'] != file_hash or record['pdf'] != raw:
                    raise ValueError('paper_evidence_hash_mismatch')
                yield
        return authority()

    def source_bytes(self, paper_id, file_hash):
        """Internal immutable byte access for explicit copy exports; never an MCP tool."""
        with self._lock:
            record = self._live(paper_id)
            if record['file_hash'] != file_hash:
                raise ValueError('paper_evidence_hash_mismatch')
            return bytes(record['pdf'])

    def status(self, paper_id):
        with self._lock:
            return copy.deepcopy(self._live(paper_id)['summary'])

    def list_items(self, paper_id, kind=None, page_index=None, offset=0, limit=50):
        if kind is not None and kind not in _KINDS:
            raise ValueError('kind')
        if page_index is not None and (type(page_index) is not int or page_index < 0):
            raise ValueError('page_index')
        if type(offset) is not int or offset < 0:
            raise ValueError('offset')
        if type(limit) is not int or not 1 <= limit <= LIST_LIMIT:
            raise ValueError('limit')
        with self._lock:
            record = self._live(paper_id)
            chosen = [item['meta'] for item in record['items']
                if (kind is None or item['meta']['type'] == kind)
                and (page_index is None or item['meta']['pageIndex'] == page_index)]
            page = chosen[offset:offset + limit]
            nxt = offset + len(page)
            return {'paperId': record['paper_id'], 'fileHash': record['file_hash'],
                'items': copy.deepcopy(page), 'total': len(chosen), 'nextOffset': nxt if nxt < len(chosen) else None}

    def read_item(self, paper_id, item_id):
        if not isinstance(item_id, str) or not item_id:
            raise ValueError('item_id')
        with self._lock:
            record = self._live(paper_id)
            for item in record['items']:
                if item['meta']['id'] == item_id:
                    body = copy.deepcopy(item['meta'])
                    if item['table'] is not None:
                        body['table'] = copy.deepcopy(item['table'])
                    return body
        raise KeyError('item')

    def render_region(self, paper_id, page_index, bbox=None, dpi=120, *, cancelled=None):
        return self._render(paper_id, page_index, bbox, dpi, MAX_PIXELS, cancelled=cancelled)

    def render_for_analysis(self, paper_id, page_index, bbox=None, dpi=200, *, cancelled=None):
        """Higher resolution input for an isolated OCR/chart worker, not a new MCP image budget."""
        return self._render(paper_id, page_index, bbox, dpi, 12_000_000, cancelled=cancelled)

    def _render(self, paper_id, page_index, bbox, dpi, pixel_limit, *, cancelled=None):
        from paper_native_worker import budget, check
        deadline = budget()
        if dpi is None:
            dpi = 120
        if type(page_index) is not int or page_index < 0:
            raise ValueError('page_index')
        if isinstance(dpi, bool) or type(dpi) not in (int, float) or not math.isfinite(dpi) or not 0 < dpi <= MAX_DPI:
            raise ValueError('dpi')
        with self._lock:
            record = self._live(paper_id)
            raw, file_hash = record['pdf'], record['file_hash']
            paper = record['paper_id']
            pages = record['summary']['pageCount']
        if page_index >= pages:
            raise ValueError('page_index')
        from paper_native_worker import run
        clip, png, width, height = run('evidence_render', [raw, page_index, bbox, dpi, pixel_limit], cancelled=cancelled, deadline=deadline)
        result = {'paperId': paper, 'fileHash': file_hash, 'pageIndex': page_index, 'bbox': clip,
            'mimeType': 'image/png', 'data': base64.b64encode(png).decode('ascii'), 'sha256': _sha(png),
            'width': width, 'height': height}
        with self.source_authority(paper, file_hash, raw):
            check(deadline, cancelled)
        return result

    def add_analysis(self, paper_id, result, fingerprint):
        """Retain a derived result separately; never rewrite native cells or source PDF bytes."""
        if not isinstance(result, dict) or result.get('kind') not in ('ocr', 'chart') or not isinstance(fingerprint, str):
            raise ValueError('analysis_invalid')
        encoded = __import__('json').dumps(result, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode('utf-8')) > 2 * 1024 * 1024: raise ValueError('analysis_limit')
        with self._lock:
            record = self._live(paper_id)
            if result.get('paperId') != paper_id or result.get('fileHash') != record['file_hash']:
                raise ValueError('analysis_hash_mismatch')
            analyses = record.setdefault('analyses', [])
            entry = copy.deepcopy(result)
            entry['analysisId'] = 'a' + secrets.token_hex(12)
            analyses.append({'fingerprint': fingerprint, 'result': entry})
            if len(analyses) > 64: del analyses[0]
            return copy.deepcopy(entry)

    def find_analysis(self, paper_id, fingerprint):
        with self._lock:
            record = self._live(paper_id)
            for entry in reversed(record.get('analyses', [])):
                if entry['fingerprint'] == fingerprint: return copy.deepcopy(entry['result'])
        return None

    def list_analyses(self, paper_id):
        with self._lock:
            record = self._live(paper_id)
            items = []
            for entry in record.get('analyses', []):
                result = entry['result']
                items.append({k: copy.deepcopy(result[k]) for k in ('analysisId', 'kind', 'pageIndex', 'bbox', 'inputImage')})
            return {'paperId': paper_id, 'fileHash': record['file_hash'], 'items': items}

    def read_analysis(self, paper_id, analysis_id):
        with self._lock:
            record = self._live(paper_id)
            for entry in record.get('analyses', []):
                if entry['result']['analysisId'] == analysis_id: return copy.deepcopy(entry['result'])
        raise KeyError('analysis')

    def _validated_pdf(self, pdf_bytes, file_hash):
        if not isinstance(file_hash, str) or not _HEX.fullmatch(file_hash):
            raise ValueError('hash_invalid')
        if not isinstance(pdf_bytes, (bytes, bytearray)):
            raise ValueError('pdf_invalid')
        raw = bytes(pdf_bytes)
        if _sha(raw) != file_hash:
            raise ValueError('hash_mismatch')
        if len(raw) > MAX_FILE_BYTES:
            raise ValueError('over_budget')
        if len(raw) < 8 or not raw.startswith(b'%PDF-'):
            raise ValueError('pdf_invalid')
        return raw

    def _open(self, raw):
        try:
            doc = pymupdf.open(stream=raw, filetype='pdf')
        except Exception:
            raise ValueError('pdf_invalid') from None
        if doc.needs_pass or doc.page_count < 1:
            doc.close()
            raise ValueError('pdf_invalid')
        if doc.page_count > MAX_PAGES:
            doc.close()
            raise ValueError('over_budget')
        return doc

    def _extract(self, raw, file_hash):
        doc = self._open(raw)
        page_count = doc.page_count
        limitations = {'failed': [], 'lines': [], 'budget': [], 'rotated': [], 'cropped': []}
        items = []
        try:
            for index in range(page_count):
                if len(items) >= MAX_ITEMS:
                    limitations['budget'].append(index)
                    continue
                try:
                    detected = _detect_page(doc[index])
                except Exception:
                    limitations['failed'].append(index)
                    continue
                _record_page_limitations(limitations, detected, index)
                page_items = self._page_items(index, detected)
                room = MAX_ITEMS - len(items)
                if len(page_items) > room:
                    limitations['budget'].append(index)
                    page_items = page_items[:room]
                items.extend(page_items)
        finally:
            doc.close()
        now = self._clock()
        paper_id = _new_id(())
        codes = []
        for name, key in (('page_extract_failed', 'failed'), ('caption_lines_failed', 'lines'),
                ('page_over_budget', 'budget'), ('rotated_page', 'rotated'), ('cropped_or_offset_page', 'cropped')):
            codes.extend(f'{name}:{i}' for i in limitations[key])
        codes.append('vector_figures_not_detected')
        status = 'partial' if limitations['failed'] or limitations['lines'] or limitations['budget'] else 'ready'
        summary = {'schema': SCHEMA, 'paperId': paper_id, 'fileHash': file_hash, 'status': status,
            'pageCount': page_count, 'counts': {
                'tables': sum(item['meta']['type'] == 'table' for item in items),
                'figures': sum(item['meta']['type'] == 'figure' for item in items)},
            'engine': ENGINE, 'limitations': codes, 'expiresAt': _iso(now + self._ttl)}
        return {'paper_id': paper_id, 'file_hash': file_hash, 'pdf': raw, 'expires_at': now + self._ttl,
            'seq': 0, 'summary': summary, 'items': items}

    def _page_items(self, index, detected):
        matrix = detected['matrix']
        drafts = []
        for table in detected['tables']:
            cells = []
            for cell in table['cells']:
                mapped = _map_box(cell['bbox'], matrix)
                if mapped is None:
                    continue
                copied = dict(cell)
                copied['bbox'] = mapped
                cells.append(copied)
            if not cells:
                continue
            drafts.append({'type': 'table', 'bbox': _union(cell['bbox'] for cell in cells), 'table': {
                'rows': table['rows'], 'columns': table['columns'], 'cells': cells}})
        for image in detected['images']:
            mapped = _map_box(image['bbox'], matrix)
            if mapped is not None:
                drafts.append({'type': 'figure', 'bbox': mapped, 'table': None})
        _attach_captions(drafts, [(_map_box(box, matrix), text) for box, text in detected['lines'] if _map_box(box, matrix)])
        existing = set()
        items = []
        for draft in drafts:
            caption = draft.get('caption')
            method = 'Page.find_tables' if draft['type'] == 'table' else 'Page.get_image_info'
            items.append({'meta': {'id': _new_id(existing, 't' if draft['type'] == 'table' else 'f'),
                'type': draft['type'], 'pageIndex': index, 'bbox': draft['bbox'], 'caption': caption,
                'provenance': _provenance(method, detected['rotation'], detected['cropped'], caption)},
                'table': draft['table']})
            existing.add(items[-1]['meta']['id'])
        items.sort(key=lambda item: (item['meta']['bbox'][1], item['meta']['bbox'][0], item['meta']['type'] != 'table'))
        return items

    def _live(self, paper_id):
        if not isinstance(paper_id, str) or not paper_id:
            raise ValueError('paper_id')
        self._purge()
        record = self._docs.get(paper_id)
        if record is None:
            raise KeyError('paper')
        return record

    def _purge(self):
        now = self._clock()
        for paper_id in [pid for pid, rec in self._docs.items() if now >= rec['expires_at']]:
            self._drop(paper_id)

    def _drop(self, paper_id):
        record = self._docs.pop(paper_id, None)
        if record is not None and self._by_hash.get(record['file_hash']) == paper_id:
            self._by_hash.pop(record['file_hash'], None)

    def _clip(self, rect, bbox):
        page = _round_box(rect)
        if page is None:
            raise ValueError('bbox')
        if bbox is None:
            return page
        _validate_clip_bbox(bbox, page)
        clipped = _round_box(pymupdf.Rect(bbox) & pymupdf.Rect(page))
        if clipped is None:
            raise ValueError('bbox')
        return clipped


def _pixel_size(box, dpi):
    width = math.ceil((box[2] - box[0]) * dpi / 72 - 1e-9)
    height = math.ceil((box[3] - box[1]) * dpi / 72 - 1e-9)
    if width < 1 or height < 1:
        raise ValueError('bbox')
    return width, height


default_store = EvidenceStore()
