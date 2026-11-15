"""Printed metric tuple extraction, reconciliation, and zero-series guards."""

import math
import re

_NUM_RE = r'[-−]?\d+(?:,\d{3})*(?:\.\d+)?'
_CI_RE = re.compile(
    rf'(?P<val>{_NUM_RE})\s*[\(\[]\s*(?:9\d%?\s*CI\s*[:=]?\s*)?(?P<lo>{_NUM_RE})\s*(?:,|to|–|—|-)\s*(?P<hi>{_NUM_RE})\s*[\)\]]',
    re.IGNORECASE,
)
_PM_RE = re.compile(
    rf'(?P<val>{_NUM_RE})\s*(?:±|\+/-)\s*(?P<err>{_NUM_RE})(?:\s*(?P<kind>SEM|SE|SD|CI))?',
    re.IGNORECASE,
)
_PAREN_ERR_RE = re.compile(
    rf'(?P<val>{_NUM_RE})\s*[\(\[]\s*(?P<kind>SEM|SE|SD)\s*[:=]?\s*(?P<err>{_NUM_RE})\s*[\)\]]',
    re.IGNORECASE,
)


def _to_float(token):
    if token is None:
        return None
    cleaned = str(token).replace('−', '-').replace(',', '').strip()
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _span_fields(span, default_source):
    if isinstance(span, dict):
        text = str(span.get('text') or '').strip()
        bbox = span.get('bbox') if span.get('bbox') is not None else span.get('box')
        source = span.get('source') or default_source
        return text, _norm_bbox(bbox), source
    return str(span or '').strip(), None, default_source


def _norm_bbox(bbox):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    try:
        return [round(float(v), 2) for v in bbox]
    except (TypeError, ValueError):
        return None


def _entry(value, lower_ci, upper_ci, sd, se, raw_text, bbox, source):
    return {
        'value': value,
        'lowerCi': lower_ci,
        'upperCi': upper_ci,
        'sd': sd,
        'se': se,
        'rawText': raw_text,
        'bbox': bbox,
        'source': source,
    }


def _match_printed_tuple(text, bbox, source):
    ci = _CI_RE.search(text)
    if ci:
        val, lo, hi = _to_float(ci.group('val')), _to_float(ci.group('lo')), _to_float(ci.group('hi'))
        if val is not None and lo is not None and hi is not None:
            return _entry(val, min(lo, hi), max(lo, hi), None, None, text, bbox, source)
    pm = _PM_RE.search(text) or _PAREN_ERR_RE.search(text)
    if pm:
        val, err = _to_float(pm.group('val')), _to_float(pm.group('err'))
        if val is not None and err is not None:
            kind = (pm.group('kind') or 'SD').upper()
            is_se = kind in ('SE', 'SEM')
            return _entry(val, None, None, None if is_se else abs(err), abs(err) if is_se else None, text, bbox, source)
    return None


def parse_printed_values(spans, *, default_source='ocr'):
    """Parse printed numeric tuples (CI/SD/SE) from PDF text spans or OCR lines."""
    if not isinstance(spans, (list, tuple)):
        return []
    out = []
    seen = set()
    for span in spans:
        text, bbox, source = _span_fields(span, default_source)
        if not text:
            continue
        parsed = _match_printed_tuple(text, bbox, source)
        if parsed is None:
            continue
        key = (parsed['value'], parsed['lowerCi'], parsed['upperCi'], parsed['sd'], parsed['se'], tuple(bbox or ()))
        if key in seen:
            continue
        seen.add(key)
        out.append(parsed)
    return out


def _fitz_module():
    import fitz
    return fitz


def extract_pdf_text_spans(source_bytes, page_index, crop, width, height):
    """Extract native PDF text lines clipped to crop in crop-pixel coordinates."""
    if not isinstance(source_bytes, (bytes, bytearray)) or b'%PDF' not in bytes(source_bytes[:1024]):
        return []
    if not isinstance(crop, (list, tuple)) or len(crop) != 4:
        return []
    x0, y0, x1, y1 = [float(v) for v in crop]
    span_w = max(1e-6, x1 - x0)
    span_h = max(1e-6, y1 - y0)
    sx = float(width or span_w) / span_w
    sy = float(height or span_h) / span_h
    fitz = _fitz_module()
    try:
        with fitz.open(stream=source_bytes, filetype='pdf') as doc:
            if page_index < 0 or page_index >= len(doc):
                return []
            data = doc[int(page_index)].get_text('dict', clip=fitz.Rect(x0, y0, x1, y1))
    except RuntimeError:
        return []
    return _collect_line_spans(data, x0, y0, sx, sy)


def _collect_line_spans(text_dict, origin_x, origin_y, sx, sy):
    spans = []
    for block in text_dict.get('blocks', []):
        if block.get('type', 0) != 0:
            continue
        for line in block.get('lines', []):
            parts = [str(item.get('text') or '') for item in line.get('spans', [])]
            text = ' '.join(p.strip() for p in parts if p.strip()).strip()
            bbox = line.get('bbox')
            if not text or not bbox or len(bbox) != 4:
                continue
            crop_box = [
                round((float(bbox[0]) - origin_x) * sx, 2),
                round((float(bbox[1]) - origin_y) * sy, 2),
                round((float(bbox[2]) - origin_x) * sx, 2),
                round((float(bbox[3]) - origin_y) * sy, 2),
            ]
            spans.append({'text': text, 'bbox': crop_box, 'source': 'pdf-text'})
    return spans


def _collect_digitized_items(series_list, numeric_cells):
    items = []
    for series in series_list or []:
        if not isinstance(series, dict):
            continue
        for pt in series.get('points', []):
            if not isinstance(pt, dict):
                continue
            val = _to_float(pt.get('y'))
            if val is not None:
                items.append({'value': val, 'ciBounds': pt.get('ciBounds')})
    if items:
        return items
    for cell in numeric_cells or []:
        if not isinstance(cell, dict):
            continue
        col = str(cell.get('column') or '').lower()
        if col in ('x', 'series', 'axis'):
            continue
        val = _to_float(cell.get('value'))
        if val is not None:
            items.append({'value': val, 'ciBounds': None})
    return items


def _close(a, b, rel=0.05, abs_tol=0.05):
    tol = max(abs_tol, rel * max(abs(a), abs(b), 1.0))
    return abs(a - b) <= tol


def _ci_discrepancy(printed, item):
    bounds = item.get('ciBounds') if isinstance(item, dict) else None
    if not isinstance(bounds, dict):
        return None
    p_lo, p_hi = printed.get('lowerCi'), printed.get('upperCi')
    d_lo, d_hi = _to_float(bounds.get('lower')), _to_float(bounds.get('upper'))
    if p_lo is None or p_hi is None or d_lo is None or d_hi is None:
        return None
    if _close(p_lo, d_lo) and _close(p_hi, d_hi):
        return None
    return {'kind': 'ci_mismatch', 'printed': [p_lo, p_hi], 'digitized': [d_lo, d_hi]}


def reconcile_printed_and_digitized(printed_values, series_list=None, numeric_cells=None):
    """Compare parsed printed tuples against digitized points/cells."""
    printed = list(printed_values or [])
    digitized = _collect_digitized_items(series_list, numeric_cells)
    if printed and not digitized:
        return {'status': 'printed_only', 'printedCount': len(printed), 'digitizedCount': 0, 'matchedCount': 0, 'discrepancies': []}
    if digitized and not printed:
        return {'status': 'digitized_only', 'printedCount': 0, 'digitizedCount': len(digitized), 'matchedCount': 0, 'discrepancies': []}
    if not printed and not digitized:
        return {'status': 'consistent', 'printedCount': 0, 'digitizedCount': 0, 'matchedCount': 0, 'discrepancies': []}
    matched, discrepancies = _match_printed_vs_digitized(printed, digitized)
    status = 'discrepant' if discrepancies else 'consistent'
    return {
        'status': status,
        'printedCount': len(printed),
        'digitizedCount': len(digitized),
        'matchedCount': matched,
        'discrepancies': discrepancies,
    }


def _match_printed_vs_digitized(printed, digitized):
    remaining = list(digitized)
    matched = 0
    discrepancies = []
    for p in printed:
        pv = p['value']
        best_idx = min(range(len(remaining)), key=lambda i: abs(remaining[i]['value'] - pv)) if remaining else None
        if best_idx is None or not _close(pv, remaining[best_idx]['value']):
            nearest = remaining[best_idx]['value'] if best_idx is not None else None
            discrepancies.append({'kind': 'value_mismatch', 'printed': pv, 'digitized': nearest, 'rawText': p.get('rawText')})
            continue
        item = remaining.pop(best_idx)
        ci_err = _ci_discrepancy(p, item)
        if ci_err is not None:
            ci_err['rawText'] = p.get('rawText')
            discrepancies.append(ci_err)
        else:
            matched += 1
    return matched, discrepancies


def _series_numeric_values(numeric_cells, columns, geometry):
    vals = []
    if isinstance(geometry, dict):
        for s in geometry.get('series', []):
            for pt in s.get('points', []):
                v = _to_float(pt.get('y'))
                if v is not None:
                    vals.append(v)
        if vals:
            return vals
    skip_cols = set()
    if isinstance(columns, list) and len(columns) >= 2:
        skip_cols.add(str(columns[0]))
    for cell in numeric_cells or []:
        if not isinstance(cell, dict):
            continue
        if str(cell.get('column') or '') in skip_cols:
            continue
        v = _to_float(cell.get('value'))
        if v is not None:
            vals.append(v)
    return vals


def _has_calibrated_y_ticks(axes, options, geometry):
    opt = options if isinstance(options, dict) else {}
    cal = opt.get('calibration') or opt.get('chartOptions') or {}
    if isinstance(cal, dict) and cal.get('allowBaselineZero'):
        return True
    tick_vals = _collect_y_tick_values(axes, cal, geometry)
    return len(tick_vals) >= 2 and (max(tick_vals) - min(tick_vals)) > 1e-9


def _collect_y_tick_values(axes, cal, geometry):
    vals = []
    for source in (geometry.get('axes') if isinstance(geometry, dict) else None, axes):
        if not isinstance(source, dict):
            continue
        for side in ('left', 'right', 'y'):
            axis = source.get(side)
            if not isinstance(axis, dict):
                continue
            for tick in axis.get('ticks', []):
                v = _to_float(tick.get('value') if isinstance(tick, dict) else tick)
                if v is not None:
                    vals.append(v)
    for item in cal.get('yTicks', []) if isinstance(cal, dict) else []:
        v = _to_float(item.get('value') if isinstance(item, dict) else item)
        if v is not None:
            vals.append(v)
    return set(vals)


def is_degenerate_zero_series(numeric_cells, columns=None, *, axes=None, options=None, geometry=None):
    """Return True when extracted series collapse to 0.0 without calibrated baseline evidence."""
    values = _series_numeric_values(numeric_cells, columns, geometry)
    if not values:
        return False
    if any(abs(v) > 1e-9 for v in values):
        return False
    return not _has_calibrated_y_ticks(axes, options, geometry)
