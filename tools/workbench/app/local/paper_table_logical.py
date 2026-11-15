"""Logical multi-grid table binding, superscript preservation, footnotes, units, and decorative image classification."""
import re

_SUP_MAP = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
    'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ',
    'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
    'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
}
_FIG_CAPTION = re.compile(r'^\s*(figure|fig\.?|그림)\b', re.IGNORECASE)
_TABLE_NUM = re.compile(r'^\s*(?:table|표)\s*([0-9]+|[ivxlcdm]+)\b', re.IGNORECASE)
_CONT_CAP = re.compile(r'\b(cont(?:inued)?\.?|계속)\b', re.IGNORECASE)
_FOOTNOTE_START = re.compile(
    r'^\s*(?:[*†‡§¶]'
    r'|(?:note|notes|abbreviations?|source|legend)\s*[:.]'
    r'|(?:95%\s*CI|CI|SD|IQR|OR|HR|RR|SE|SEM)\s*[,:=]'
    r'|[a-z]\s+[A-Z0-9(]'
    r'|[a-z][.)]\s+\S'
    r'|[⁰¹²³⁴⁵⁶⁷⁸⁹ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ]+\s*\S)'
)
_UNIT_PATTERNS = (
    re.compile(r'\bkg/m[²2]\b'),
    re.compile(r'\bm[²2]\b'),
    re.compile(r'\bm[³3]\b'),
    re.compile(r'\b95%\s*CI\b'),
    re.compile(r'\bn\s*\(%\)\b', re.IGNORECASE),
    re.compile(r'\(\s*%\s*\)'),
    re.compile(r'\b(?:mg/dL|mmol/L|µmol/L|μmol/L|µg/mL|μg/mL|µg/L|μg/L|ng/mL|pg/mL|mm\s*Hg|mmHg|mL/min|g/dL|U/L|IU/L|kPa|bpm)\b'),
    re.compile(r'\b10[⁶⁹69]/[µμ]?L\b'),
    re.compile(r'\b(?:years?|yrs?|months?|weeks?|days?|hours?|hrs?|min|cm|mm|kg|mg|µg|μg)\b'),
    re.compile(r'\d+(?:\.\d+)?\s*%'),
)
_UNIT_NORM = {'kg/m2': 'kg/m²', 'm2': 'm²', 'm3': 'm³'}


def to_superscript(text):
    """Convert plain span text to Unicode superscripts when every character maps cleanly, else ^{...}."""
    stripped = text.strip()
    if not stripped:
        return text
    if all(ch in _SUP_MAP or ch.isspace() for ch in stripped):
        return ''.join(_SUP_MAP.get(ch, ch) for ch in text)
    return f'^{{{stripped}}}'


def _span_record(span):
    bbox = span.get('bbox')
    text = span.get('text', '')
    if not text or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    return {
        'text': text,
        'bbox': [float(v) for v in bbox],
        'size': float(span.get('size') or 0.0),
        'flags': int(span.get('flags') or 0),
    }


def extract_page_spans(page_dict):
    """Extract normalized span dicts from a PyMuPDF get_text('dict') payload."""
    spans = []
    for block in (page_dict or {}).get('blocks', []):
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                rec = _span_record(span)
                if rec is not None:
                    spans.append(rec)
    return spans


def _is_superscript_span(span, base_size, base_cy, base_y1, peer_count):
    if peer_count < 2 or not span['text'].strip():
        return False
    if span['flags'] & 1:
        return span['size'] <= base_size * 0.95 or _span_cy(span) < base_cy
    if base_size <= 0 or span['size'] > base_size * 0.82:
        return False
    return _span_cy(span) < base_cy - base_size * 0.12 and span['bbox'][3] <= base_y1 - base_size * 0.1


def _span_cy(span):
    return (span['bbox'][1] + span['bbox'][3]) / 2.0


def _cluster_visual_lines(spans):
    ordered = sorted(spans, key=lambda s: (_span_cy(s), s['bbox'][0]))
    lines = []
    for span in ordered:
        cy = _span_cy(span)
        height = max(4.0, span['bbox'][3] - span['bbox'][1])
        placed = False
        for line in reversed(lines):
            l_y0 = min(s['bbox'][1] for s in line)
            l_y1 = max(s['bbox'][3] for s in line)
            l_cy = (l_y0 + l_y1) / 2.0
            if abs(cy - l_cy) <= max(height, l_y1 - l_y0) * 0.55:
                line.append(span)
                placed = True
                break
        if not placed:
            lines.append([span])
    lines.sort(key=lambda ln: min(s['bbox'][1] for s in ln))
    return [sorted(ln, key=lambda s: s['bbox'][0]) for ln in lines]


def _base_metrics(line_spans):
    non_sup = [s for s in line_spans if not (s['flags'] & 1) and s['text'].strip()] or line_spans
    base = max(non_sup, key=lambda s: (s['size'], len(s['text'])))
    return base['size'], _span_cy(base), base['bbox'][3]


def line_text_with_superscripts(line_spans):
    """Render one visual line of spans, preserving superscripts as Unicode superscripts."""
    if not line_spans:
        return '', False
    ordered = sorted(line_spans, key=lambda s: s['bbox'][0])
    base_size, base_cy, base_y1 = _base_metrics(ordered)
    parts, prev_x1, changed = [], None, False
    for span in ordered:
        txt = span['text']
        sup = _is_superscript_span(span, base_size, base_cy, base_y1, len(ordered))
        if prev_x1 is not None and not sup and parts and not parts[-1].endswith((' ', '\n')) and not txt.startswith(' '):
            if span['bbox'][0] - prev_x1 > max(1.0, base_size * 0.18):
                parts.append(' ')
        if sup:
            converted = to_superscript(txt.strip())
            changed = changed or (converted != txt)
            parts.append(converted)
        else:
            parts.append(txt)
        prev_x1 = max(prev_x1, span['bbox'][2]) if prev_x1 is not None else span['bbox'][2]
    return ''.join(parts).strip(), changed


def cell_text_with_superscripts(cell_bbox, page_spans, fallback_text):
    """Return (text, had_superscripts) for a table cell bbox using page spans when superscripts exist."""
    if not page_spans or not cell_bbox:
        return fallback_text, False
    x0, y0, x1, y1 = cell_bbox
    inside = [
        s for s in page_spans
        if (x0 - 1.0) <= (s['bbox'][0] + s['bbox'][2]) / 2.0 <= (x1 + 1.0)
        and (y0 - 1.0) <= (s['bbox'][1] + s['bbox'][3]) / 2.0 <= (y1 + 1.0)
    ]
    if len(inside) < 2:
        return fallback_text, False
    lines = _cluster_visual_lines(inside)
    rendered, any_sup = [], False
    for line in lines:
        text, changed = line_text_with_superscripts(line)
        if text:
            rendered.append(text)
        any_sup = any_sup or changed
    if not any_sup:
        return fallback_text, False
    return '\n'.join(rendered), True


def _is_small_margin_figure(item, page_height):
    if item['meta'].get('caption') or page_height <= 0:
        return False
    x0, y0, x1, y1 = item['meta']['bbox']
    width, height = x1 - x0, y1 - y0
    if width > 140.0 or height > 60.0:
        return False
    return y1 <= 0.12 * page_height or y0 >= 0.88 * page_height


def _margin_slot(bbox):
    return (round(bbox[0], 1), round(bbox[1], 1), round(bbox[2] - bbox[0], 1), round(bbox[3] - bbox[1], 1))


def classify_figures(items, page_heights):
    """Classify figure items as 'decorative' (repeated logo/furniture) or 'scientific'."""
    digest_pages, slot_pages = {}, {}
    for item in items:
        meta = item['meta']
        if meta['type'] != 'figure' or meta.get('caption'):
            continue
        page_idx = meta['pageIndex']
        key = item.get('_repeat_key') or meta.get('imageSha256')
        if key:
            digest_pages.setdefault(key, set()).add(page_idx)
        page_h = page_heights.get(page_idx, 0.0)
        if _is_small_margin_figure(item, page_h):
            slot_pages.setdefault(_margin_slot(meta['bbox']), set()).add(page_idx)
    for item in items:
        meta = item['meta']
        if meta['type'] != 'figure':
            continue
        meta['classification'] = _figure_class(item, page_heights, digest_pages, slot_pages)


def _figure_class(item, page_heights, digest_pages, slot_pages):
    meta = item['meta']
    if meta.get('caption'):
        return 'scientific'
    key = item.get('_repeat_key') or meta.get('imageSha256')
    d_count = len(digest_pages.get(key, ())) if key else 0
    if d_count >= 3:
        return 'decorative'
    page_h = page_heights.get(meta['pageIndex'], 0.0)
    if _is_small_margin_figure(item, page_h):
        s_count = len(slot_pages.get(_margin_slot(meta['bbox']), ()))
        if d_count >= 2 or s_count >= 2:
            return 'decorative'
    return 'scientific'


def _horiz_overlap_ratio(box_a, box_b):
    overlap = max(0.0, min(box_a[2], box_b[2]) - max(box_a[0], box_b[0]))
    width = min(box_a[2] - box_a[0], box_b[2] - box_b[0])
    return overlap / width if width > 0 else 0.0


def _table_number(caption):
    if not caption:
        return None
    m = _TABLE_NUM.match(caption)
    return m.group(1).lower() if m else None


def _has_intervening_text(page_lines, y_top, y_bot, box_a, box_b, ignore_text=None):
    min_x, max_x = min(box_a[0], box_b[0]) - 12.0, max(box_a[2], box_b[2]) + 12.0
    for lbox, text in page_lines:
        stripped = text.strip()
        if not stripped or (ignore_text and stripped == ignore_text.strip()):
            continue
        if lbox[1] >= y_top - 1.0 and lbox[3] <= y_bot + 1.0 and lbox[2] >= min_x and lbox[0] <= max_x:
            return True
    return False


def _same_page_continuation(prev_item, curr_item, page_lines):
    pa, pb = prev_item['meta'], curr_item['meta']
    if pa['pageIndex'] != pb['pageIndex']:
        return False
    gap = pb['bbox'][1] - pa['bbox'][3]
    if not (-4.0 <= gap <= 36.0):
        return False
    if _horiz_overlap_ratio(pa['bbox'], pb['bbox']) < 0.65:
        return False
    num_a, num_b = _table_number(pa.get('caption')), _table_number(pb.get('caption'))
    if num_b is not None and (num_a != num_b or not _CONT_CAP.search(pb.get('caption') or '')):
        return False
    if _has_intervening_text(page_lines.get(pa['pageIndex'], ()), pa['bbox'][3], pb['bbox'][1], pa['bbox'], pb['bbox'], ignore_text=pb.get('caption')):
        return False
    return abs(prev_item['table']['columns'] - curr_item['table']['columns']) <= 1


def _group_table_number(group):
    for item in group:
        num = _table_number(item['meta'].get('caption'))
        if num is not None:
            return num
    return None


def _cross_page_continuation(prev_item, curr_item, page_heights, page_lines, page_tables, group_num=None):
    pa, pb = prev_item['meta'], curr_item['meta']
    if pb['pageIndex'] != pa['pageIndex'] + 1:
        return False
    if page_tables[pa['pageIndex']][-1] is not prev_item or page_tables[pb['pageIndex']][0] is not curr_item:
        return False
    num_a = group_num if group_num is not None else _table_number(pa.get('caption'))
    num_b = _table_number(pb.get('caption'))
    if num_b is not None:
        return num_a is not None and num_b == num_a and bool(_CONT_CAP.search(pb.get('caption') or ''))
    if _horiz_overlap_ratio(pa['bbox'], pb['bbox']) < 0.65:
        return False
    if abs(prev_item['table']['columns'] - curr_item['table']['columns']) > 1:
        return False
    if pb['bbox'][1] > 0.35 * page_heights.get(pb['pageIndex'], 842.0):
        return False
    return not _has_noncaption_below(page_lines.get(pa['pageIndex'], ()), pa['bbox'][3], page_heights.get(pa['pageIndex'], 842.0))


def _has_noncaption_below(lines, y_after, page_height):
    prose = 0
    for lbox, text in lines:
        if lbox[1] <= y_after + 2.0 or lbox[1] >= 0.90 * page_height:
            continue
        stripped = text.strip()
        if not stripped or _FOOTNOTE_START.match(stripped):
            continue
        prose += 1
        if prose >= 2:
            return True
    return False


def extract_table_footnotes(table_bbox, lines, next_y0):
    """Extract footnote text lines immediately below table_bbox."""
    if not lines:
        return []
    tx0, _ty0, tx1, ty1 = table_bbox
    limit_y = min(ty1 + 96.0, next_y0) if next_y0 is not None else ty1 + 96.0
    candidates = [
        (lbox, text.strip()) for lbox, text in lines
        if (ty1 - 2.0) <= lbox[1] <= limit_y and lbox[2] >= tx0 - 16.0 and lbox[0] <= tx1 + 16.0 and text.strip()
    ]
    candidates.sort(key=lambda pair: (pair[0][1], pair[0][0]))
    notes, last_y, in_note = [], None, False
    for lbox, text in candidates:
        if last_y is not None and lbox[1] - last_y > 18.0:
            break
        if _FOOTNOTE_START.match(text):
            notes.append(text)
            in_note = True
        elif in_note and (last_y is not None and lbox[1] - last_y <= 6.0) and not _TABLE_NUM.match(text):
            notes[-1] = notes[-1] + ' ' + text
        else:
            break
        last_y = lbox[3]
    return notes


def extract_table_units(cells, caption, footnotes):
    """Extract normalized scientific/statistical unit tokens from cells, caption, and footnotes."""
    texts = [caption or ''] + [c.get('text', '') for c in (cells or ())] + list(footnotes or ())
    found, seen = [], set()
    for blob in texts:
        if not blob:
            continue
        for pat in _UNIT_PATTERNS:
            for m in pat.finditer(blob):
                raw = ' '.join(m.group(0).split())
                unit = '%' if raw.endswith('%') and raw[0].isdigit() else _UNIT_NORM.get(raw, raw)
                if unit not in seen:
                    seen.add(unit)
                    found.append(unit)
    return found


def _next_item_top(items, table_item):
    page_idx, ty1 = table_item['meta']['pageIndex'], table_item['meta']['bbox'][3]
    tops = [it['meta']['bbox'][1] for it in items if it is not table_item and it['meta']['pageIndex'] == page_idx and it['meta']['bbox'][1] >= ty1 - 2.0]
    return min(tops) if tops else None


def _group_tables(tables, page_heights, page_lines):
    page_tables = {}
    for t in tables:
        page_tables.setdefault(t['meta']['pageIndex'], []).append(t)
    groups = []
    for t in tables:
        if groups and (
            _same_page_continuation(groups[-1][-1], t, page_lines)
            or _cross_page_continuation(groups[-1][-1], t, page_heights, page_lines, page_tables, _group_table_number(groups[-1]))
        ):
            groups[-1].append(t)
        else:
            groups.append([t])
    return groups


def _part_summary(part):
    meta, tbl = part['meta'], part['table']
    return {
        'itemId': meta['id'],
        'pageIndex': meta['pageIndex'],
        'partIndex': meta['partIndex'],
        'rows': tbl['rows'],
        'columns': tbl['columns'],
        'caption': meta.get('caption'),
    }


def bind_logical_tables(items, page_heights, page_lines):
    """Bind multi-grid/cross-page tables and attach footnotes, units, and logicalTable metadata."""
    tables = [it for it in items if it['meta']['type'] == 'table']
    for t in tables:
        lines = page_lines.get(t['meta']['pageIndex'], ())
        notes = extract_table_footnotes(t['meta']['bbox'], lines, _next_item_top(items, t))
        units = extract_table_units(t['table']['cells'], t['meta'].get('caption'), notes)
        t['meta']['footnotes'] = notes
        t['meta']['units'] = units
    for idx, group in enumerate(_group_tables(tables, page_heights, page_lines), start=1):
        logical_id = f'logical-table-{idx}'
        part_ids = [p['meta']['id'] for p in group]
        all_notes = [n for p in group for n in p['meta']['footnotes']]
        all_units = list(dict.fromkeys(u for p in group for u in p['meta']['units']))
        root_caption = next((p['meta'].get('caption') for p in group if p['meta'].get('caption')), None)
        for p_idx, part in enumerate(group):
            meta = part['meta']
            meta['logicalTableId'] = logical_id
            meta['partIndex'] = p_idx
            meta['partCount'] = len(group)
            meta['continuedFromId'] = part_ids[p_idx - 1] if p_idx > 0 else None
            meta['continuedIds'] = part_ids[p_idx + 1:]
        parts_meta = [_part_summary(p) for p in group]
        for part in group:
            meta = part['meta']
            part['logical_table'] = {
                'logicalTableId': logical_id,
                'caption': root_caption,
                'partIndex': meta['partIndex'],
                'partCount': meta['partCount'],
                'partIds': part_ids,
                'continuedFromId': meta['continuedFromId'],
                'continuedIds': meta['continuedIds'],
                'footnotes': all_notes,
                'units': all_units,
                'parts': parts_meta,
            }
