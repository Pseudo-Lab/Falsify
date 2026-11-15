"""Forensic and visual stealth self-audit for RED edited PDFs."""
from collections import Counter
import hashlib
import io
import math
import re

import numpy as np
import pikepdf
import pymupdf

SCHEMA = 'falsify.red-stealth-audit.v1'
BLINDNESS_SCHEMA = 'falsify.red-blindness-audit.v1'
LEAK_TOKENS = (
    'falsify', 'red-plan', 'attack', 'candidate', 'rationale', 'before', 'after',
    'falsify-red', 'tampered', 'answer-key', 'answer_key', '변조', '정답', '의도적',
)
BLINDNESS_TEXT_PATTERNS = (
    re.compile(r'\b\d+\s+intentional\s+(?:errors?|defects?|flaws?|mutations?)\b', re.I),
    re.compile(r'\b(?:intentional|injected|planted|synthetic)\s+(?:errors?|defects?|flaws?|mutations?)\b', re.I),
    re.compile(r'\b(?:answer[\s_-]*key|tampered[\s_-]*(?:copy|pdf|version)|red[\s_-]*team[\s_-]*injected)\b', re.I),
    re.compile(r'(?:의도적\s*(?:오류|결함)|변조본|주입된?\s*결함|결함\s*\d+\s*개|오류\s*\d+\s*개\s*(?:주입|포함)|정답지|정답표)'),
)
BLINDNESS_META_PATTERNS = BLINDNESS_TEXT_PATTERNS + (
    re.compile(r'(?:falsify-red|red-plan|tampered|변조|정답)', re.I),
)
SEAM_WARNING_THRESHOLD = 40


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _as_pdf_bytes(data, label):
    if not isinstance(data, (bytes, bytearray)) or not bytes(data).startswith(b'%PDF-'):
        raise ValueError(f'{label}_pdf_invalid')
    return bytes(data)


def _pikepdf_docinfo_text(raw):
    parts = []
    try:
        with pikepdf.Pdf.open(io.BytesIO(raw)) as pdf:
            for key, val in pdf.docinfo.items():
                parts.append(str(key))
                parts.append(str(val))
    except Exception:
        return ''
    return '\n'.join(parts)


def _metadata_corpus(raw, doc):
    parts = []
    meta = doc.metadata or {}
    for key, val in meta.items():
        if val is not None:
            parts.append(f'{key}:{val}')
    try:
        xmp = doc.get_xml_metadata()
        if xmp:
            parts.append(xmp)
    except Exception:
        pass
    parts.append(_pikepdf_docinfo_text(raw))
    return '\n'.join(parts).lower()


def _check_metadata(src_bytes, src_doc, out_bytes, out_doc):
    src_corpus = _metadata_corpus(src_bytes, src_doc)
    out_corpus = _metadata_corpus(out_bytes, out_doc)
    issues = []
    for token in LEAK_TOKENS:
        if token in out_corpus and token not in src_corpus:
            issues.append({'code': 'metadata_leak', 'severity': 'detectable_artifact', 'token': token})
    for pat in BLINDNESS_TEXT_PATTERNS:
        if len(pat.findall(out_corpus)) > len(pat.findall(src_corpus)):
            issues.append({'code': 'metadata_leak', 'severity': 'detectable_artifact', 'token': pat.pattern})
    return not issues, issues


def _snippet(text, start, end):
    lo = max(0, start - 20)
    hi = min(len(text), end + 20)
    return ' '.join(text[lo:hi].split())


def _diff_pattern_matches(src_text, out_text, patterns, surface, page_index=None):
    issues = []
    if not out_text:
        return issues
    for pat in patterns:
        src_counts = Counter(m.group(0).lower() for m in pat.finditer(src_text or ''))
        for m in pat.finditer(out_text):
            key = m.group(0).lower()
            if src_counts[key] > 0:
                src_counts[key] -= 1
                continue
            item = {
                'code': 'blindness_hint_leak',
                'severity': 'detectable_artifact',
                'surface': surface,
                'pattern': pat.pattern,
                'snippet': _snippet(out_text, m.start(), m.end()),
            }
            if page_index is not None:
                item['pageIndex'] = page_index
            issues.append(item)
    return issues


def _extract_annot_strings(page):
    items = []
    for annot in list(page.annots() or []):
        info = annot.info or {}
        for key in ('content', 'title', 'subject', 'id'):
            val = info.get(key)
            if isinstance(val, str) and val.strip():
                items.append(val.strip())
        uri = getattr(annot, 'uri', None)
        if isinstance(uri, str) and uri.strip():
            items.append(uri.strip())
    for link in page.get_links() or []:
        uri = link.get('uri') if isinstance(link, dict) else None
        if isinstance(uri, str) and uri.strip():
            items.append(uri.strip())
    return items


def _scan_page_annot_leaks(src_doc, out_doc):
    issues = []
    for idx in range(len(out_doc)):
        out_items = _extract_annot_strings(out_doc[idx])
        if not out_items:
            continue
        src_items = _extract_annot_strings(src_doc[idx]) if idx < len(src_doc) else []
        added = list((Counter(out_items) - Counter(src_items)).elements())
        if not added:
            continue
        issues.extend(_diff_pattern_matches('\n'.join(src_items), '\n'.join(added), BLINDNESS_META_PATTERNS, 'annotation', page_index=idx))
    return issues


def _visible_lines(page):
    return [line.strip() for line in (page.get_text('text') or '').splitlines() if line.strip()]


def _scan_page_text_leaks(src_doc, out_doc):
    issues = []
    for idx in range(len(out_doc)):
        out_lines = _visible_lines(out_doc[idx])
        src_lines = _visible_lines(src_doc[idx]) if idx < len(src_doc) else []
        added_lines = list((Counter(out_lines) - Counter(src_lines)).elements())
        if not added_lines:
            continue
        src_text = (src_doc[idx].get_text('text') or '') if idx < len(src_doc) else ''
        issues.extend(_diff_pattern_matches(src_text, '\n'.join(added_lines), BLINDNESS_TEXT_PATTERNS, 'text', page_index=idx))
    return issues


def _scan_blindness_leaks(src_bytes, src_doc, out_bytes, out_doc):
    src_corpus = _metadata_corpus(src_bytes, src_doc)
    out_corpus = _metadata_corpus(out_bytes, out_doc)
    issues = _diff_pattern_matches(src_corpus, out_corpus, BLINDNESS_META_PATTERNS, 'metadata')
    issues.extend(_scan_page_annot_leaks(src_doc, out_doc))
    issues.extend(_scan_page_text_leaks(src_doc, out_doc))
    return issues


def audit_blindness_leaks(source_pdf_bytes: bytes, edited_pdf_bytes: bytes) -> dict:
    """Scan edited PDF metadata, annotations/URIs, and newly introduced text lines for blindness-breaking hints."""
    src_bytes = _as_pdf_bytes(source_pdf_bytes, 'source')
    out_bytes = _as_pdf_bytes(edited_pdf_bytes, 'edited')
    with pymupdf.open(stream=src_bytes, filetype='pdf') as src_doc, pymupdf.open(stream=out_bytes, filetype='pdf') as out_doc:
        issues = _scan_blindness_leaks(src_bytes, src_doc, out_bytes, out_doc)
    return {
        'schema': BLINDNESS_SCHEMA,
        'sourceSha256': _sha256(src_bytes),
        'outputSha256': _sha256(out_bytes),
        'clean': not issues,
        'issues': issues,
    }


def _normalize_regions(modified_regions):
    if modified_regions is None:
        return None
    if not isinstance(modified_regions, list):
        raise ValueError('modified_regions_invalid')
    regions = []
    for item in modified_regions:
        if not isinstance(item, dict) or type(item.get('pageIndex')) is not int or item['pageIndex'] < 0:
            raise ValueError('modified_regions_invalid')
        bbox = item.get('bbox')
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise ValueError('modified_regions_invalid')
        vals = [float(v) for v in bbox]
        if any(not math.isfinite(v) for v in vals) or vals[2] <= vals[0] or vals[3] <= vals[1]:
            raise ValueError('modified_regions_invalid')
        regions.append({'pageIndex': item['pageIndex'], 'bbox': vals})
    return regions


def _render_rgb(page, dpi=150, clip=None):
    pix = page.get_pixmap(clip=clip, dpi=dpi, colorspace=pymupdf.csRGB, alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8)
    return arr.reshape(pix.height, pix.width, 3).astype(np.int16)


def _page_diff(src_page, out_page, dpi=150):
    text_changed = src_page.get_text() != out_page.get_text()
    src_arr = _render_rgb(src_page, dpi=dpi)
    out_arr = _render_rgb(out_page, dpi=dpi)
    if src_arr.shape != out_arr.shape:
        return text_changed, True, 255
    max_diff = int(np.abs(out_arr - src_arr).max()) if src_arr.size else 0
    return text_changed, False, max_diff


def _check_unmodified_pages(src_doc, out_doc, touched_pages):
    if len(src_doc) != len(out_doc):
        return False, []
    ok, issues = True, []
    for idx in range(len(src_doc)):
        if idx in touched_pages:
            continue
        text_changed, shape_changed, max_diff = _page_diff(src_doc[idx], out_doc[idx], dpi=150)
        if text_changed or shape_changed or max_diff > 2:
            ok = False
            issues.append({
                'code': 'unmodified_page_changed',
                'severity': 'detectable_artifact',
                'pageIndex': idx,
                'textChanged': text_changed,
                'maxPixelDiff': max_diff,
            })
    return ok, issues


def _detect_changed_pages(src_doc, out_doc):
    changed = set()
    for idx in range(min(len(src_doc), len(out_doc))):
        text_changed, shape_changed, max_diff = _page_diff(src_doc[idx], out_doc[idx], dpi=150)
        if text_changed or shape_changed or max_diff > 2:
            changed.add(idx)
    return changed


def _same_column_or_backjump(prev_box, tail_box, page_width):
    mid = page_width / 2.0
    prev_left = (prev_box[0] + prev_box[2]) / 2.0 < mid
    tail_left = (tail_box[0] + tail_box[2]) / 2.0 < mid
    x_overlap = min(prev_box[2], tail_box[2]) - max(prev_box[0], tail_box[0]) > 4.0
    return x_overlap or (prev_left == tail_left) or (not prev_left and tail_left)


def _tail_order_jumps(page, page_index):
    blocks = [b for b in page.get_text('blocks') if len(b) >= 7 and b[6] == 0 and str(b[4]).strip()]
    if len(blocks) < 2:
        return []
    height, width = float(page.rect.height), float(page.rect.width)
    start_tail = max(1, len(blocks) - 3)
    jumps = []
    for i in range(start_tail, len(blocks)):
        tail = blocks[i]
        if tail[1] >= height * 0.80:
            continue
        for prev in blocks[:i]:
            if (tail[3] < prev[1] - 4.0 or tail[1] < prev[1] - 12.0) and _same_column_or_backjump(prev, tail, width):
                jumps.append({
                    'code': 'append_order_jump',
                    'severity': 'warning',
                    'pageIndex': page_index,
                    'blockIndex': i,
                    'y0': round(float(tail[1]), 2),
                    'precededByY0': round(float(prev[1]), 2),
                })
                break
    return jumps


def _check_reading_order(src_doc, out_doc, modified_pages):
    issues = []
    for idx in sorted(modified_pages):
        if idx >= len(src_doc) or idx >= len(out_doc):
            continue
        out_jumps = _tail_order_jumps(out_doc[idx], idx)
        src_jumps = _tail_order_jumps(src_doc[idx], idx)
        if len(out_jumps) > len(src_jumps):
            issues.extend(out_jumps[len(src_jumps):])
    return not issues, issues


def _pixel_box(bbox, crop, width, height, pad=0.0):
    sx = width / crop.width
    sy = height / crop.height
    x0 = max(0, math.floor((bbox[0] - pad - crop.x0) * sx))
    y0 = max(0, math.floor((bbox[1] - pad - crop.y0) * sy))
    x1 = min(width, math.ceil((bbox[2] + pad - crop.x0) * sx))
    y1 = min(height, math.ceil((bbox[3] + pad - crop.y0) * sy))
    return x0, y0, x1, y1


def _edge_step_delta(src_arr, out_arr, box):
    bx0, by0, bx1, by1 = box
    h, w = src_arr.shape[:2]
    deltas = [0]
    if by0 > 0 and bx1 > bx0:
        deltas.append(int(np.abs((out_arr[by0, bx0:bx1] - out_arr[by0 - 1, bx0:bx1]) - (src_arr[by0, bx0:bx1] - src_arr[by0 - 1, bx0:bx1])).max()))
    if by1 < h and bx1 > bx0 and by1 > 0:
        deltas.append(int(np.abs((out_arr[by1 - 1, bx0:bx1] - out_arr[by1, bx0:bx1]) - (src_arr[by1 - 1, bx0:bx1] - src_arr[by1, bx0:bx1])).max()))
    if bx0 > 0 and by1 > by0:
        deltas.append(int(np.abs((out_arr[by0:by1, bx0] - out_arr[by0:by1, bx0 - 1]) - (src_arr[by0:by1, bx0] - src_arr[by0:by1, bx0 - 1])).max()))
    if bx1 < w and by1 > by0 and bx1 > 0:
        deltas.append(int(np.abs((out_arr[by0:by1, bx1 - 1] - out_arr[by0:by1, bx1]) - (src_arr[by0:by1, bx1 - 1] - src_arr[by0:by1, bx1])).max()))
    return max(deltas)


def _audit_single_region(src_page, out_page, region):
    bbox = region['bbox']
    page_idx = region['pageIndex']
    crop = pymupdf.Rect(bbox[0] - 6.0, bbox[1] - 6.0, bbox[2] + 6.0, bbox[3] + 6.0) & src_page.rect
    if crop.is_empty:
        return True, [], {'pageIndex': page_idx, 'bbox': bbox, 'exteriorMaxDiff': 0, 'seamMaxDelta': 0}
    src_arr = _render_rgb(src_page, dpi=144, clip=crop)
    out_arr = _render_rgb(out_page, dpi=144, clip=crop)
    if src_arr.shape != out_arr.shape or not src_arr.size:
        issue = {'code': 'exterior_pixels_changed', 'severity': 'detectable_artifact', 'pageIndex': page_idx, 'bbox': bbox, 'maxDiff': 255}
        return False, [issue], {'pageIndex': page_idx, 'bbox': bbox, 'exteriorMaxDiff': 255, 'seamMaxDelta': 255}
    h, w = src_arr.shape[:2]
    ix0, iy0, ix1, iy1 = _pixel_box(bbox, crop, w, h, pad=2.0)
    mask = np.ones((h, w), dtype=bool)
    mask[iy0:iy1, ix0:ix1] = False
    ext_diff = int(np.abs(out_arr - src_arr)[mask].max()) if mask.any() else 0
    seam_delta = _edge_step_delta(src_arr, out_arr, _pixel_box(bbox, crop, w, h, pad=0.0))
    issues, ext_ok = [], ext_diff <= 3
    if not ext_ok:
        issues.append({'code': 'exterior_pixels_changed', 'severity': 'detectable_artifact', 'pageIndex': page_idx, 'bbox': bbox, 'maxDiff': ext_diff})
    if seam_delta > SEAM_WARNING_THRESHOLD:
        issues.append({'code': 'boundary_seam_discontinuity', 'severity': 'warning', 'pageIndex': page_idx, 'bbox': bbox, 'seamMaxDelta': seam_delta})
    return ext_ok, issues, {'pageIndex': page_idx, 'bbox': bbox, 'exteriorMaxDiff': ext_diff, 'seamMaxDelta': seam_delta}


def _check_boundary_seams(src_doc, out_doc, regions):
    if not regions:
        return True, [], []
    ext_ok, issues, metrics = True, [], []
    for region in regions:
        idx = region['pageIndex']
        if idx >= len(src_doc) or idx >= len(out_doc):
            ext_ok = False
            issues.append({'code': 'exterior_pixels_changed', 'severity': 'detectable_artifact', 'pageIndex': idx, 'bbox': region['bbox'], 'maxDiff': 255})
            continue
        ok, reg_issues, metric = _audit_single_region(src_doc[idx], out_doc[idx], region)
        ext_ok = ext_ok and ok
        issues.extend(reg_issues)
        metrics.append(metric)
    return ext_ok, issues, metrics


def _overall_status(checks, issues):
    if (not checks['metadataClean'] or not checks['pageCountPreserved']
            or not checks['unmodifiedPagesIdentical'] or not checks['exteriorPixelsPreserved']
            or any(i.get('severity') == 'detectable_artifact' for i in issues)):
        return 'detectable_artifact'
    if not checks['readingOrderOk'] or any(i.get('severity') == 'warning' for i in issues):
        return 'warning'
    return 'clean'


def audit_pdf_stealth(source_pdf_bytes: bytes, edited_pdf_bytes: bytes, modified_regions: list[dict] | None = None) -> dict:
    """Audit edited PDF bytes against source PDF bytes for metadata leaks, exterior/page preservation, reading order, and boundary seams."""
    src_bytes = _as_pdf_bytes(source_pdf_bytes, 'source')
    out_bytes = _as_pdf_bytes(edited_pdf_bytes, 'edited')
    regions = _normalize_regions(modified_regions)
    with pymupdf.open(stream=src_bytes, filetype='pdf') as src_doc, pymupdf.open(stream=out_bytes, filetype='pdf') as out_doc:
        meta_clean, meta_issues = _check_metadata(src_bytes, src_doc, out_bytes, out_doc)
        pages_ok = len(src_doc) == len(out_doc)
        issues = list(meta_issues)
        if not pages_ok:
            issues.append({'code': 'page_count_changed', 'severity': 'detectable_artifact', 'sourcePages': len(src_doc), 'outputPages': len(out_doc)})
        if regions is None:
            unmod_ok, unmod_issues = pages_ok, []
            touched = _detect_changed_pages(src_doc, out_doc)
        else:
            touched = {r['pageIndex'] for r in regions}
            unmod_ok, unmod_issues = _check_unmodified_pages(src_doc, out_doc, touched)
        issues.extend(unmod_issues)
        order_ok, order_issues = _check_reading_order(src_doc, out_doc, touched)
        issues.extend(order_issues)
        ext_ok, seam_issues, seam_metrics = _check_boundary_seams(src_doc, out_doc, regions)
        issues.extend(seam_issues)
        blind_issues = _scan_blindness_leaks(src_bytes, src_doc, out_bytes, out_doc)
        issues.extend(blind_issues)
    checks = {
        'metadataClean': meta_clean,
        'pageCountPreserved': pages_ok,
        'unmodifiedPagesIdentical': unmod_ok,
        'readingOrderOk': order_ok,
        'exteriorPixelsPreserved': ext_ok,
        'blindnessClean': not blind_issues,
    }
    return {
        'schema': SCHEMA,
        'sourceSha256': _sha256(src_bytes),
        'outputSha256': _sha256(out_bytes),
        'status': _overall_status(checks, issues),
        'checks': checks,
        'issues': issues,
        'seamMetrics': seam_metrics,
    }
