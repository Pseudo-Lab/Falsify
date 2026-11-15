"""On-demand omitted paperEvidence reread and two-stage auto-crop visual helpers for BLUE."""
import base64
import copy
import hashlib
import json
import math

from blue_visual import validate_png

MAX_OMITTED_CATALOG = 32
MAX_OMITTED_SELECTIONS = 4
MAX_REREAD_ITEMS_CHARS = 12_000
MAX_AUTO_CROPS = 2
MAX_VISUAL_IMAGES = 6
MAX_PNG_BYTES = 524_288
EVITEM_PREFIX = 'evitem:'
_CROP_DPIS = (144, 96)


def is_evitem_anchor(anchor):
    """True for omitted structured-evidence anchors (evitem:<itemId>)."""
    return isinstance(anchor, str) and anchor.startswith(EVITEM_PREFIX)


def build_omitted_catalog(structured, data):
    """Build bounded catalog (up to 32) of omitted paperEvidence items for selection."""
    if not structured or not data.get('paperEvidence'):
        return [], {}
    omitted_ids = structured.get('coverage', {}).get('omittedIds')
    segments = data.get('segments')
    if not isinstance(omitted_ids, list) or not omitted_ids or not segments:
        return [], {}
    first_segment_id = segments[0]['id']
    catalog, seen = [], set()
    for raw_id in omitted_ids:
        if not isinstance(raw_id, str) or not raw_id or raw_id in seen:
            continue
        seen.add(raw_id)
        catalog.append({'refId': EVITEM_PREFIX + raw_id, 'itemId': raw_id, 'segmentId': first_segment_id})
        if len(catalog) >= MAX_OMITTED_CATALOG:
            break
    return catalog, {entry['refId']: entry for entry in catalog}


def resolve_evitem_target(anchor, omitted_catalog):
    """Resolve an evitem:<itemId> anchor only against the catalog delivered in this selection call."""
    if not isinstance(omitted_catalog, dict) or anchor not in omitted_catalog:
        raise ValueError('BLUE 재독 근거 참조 ID가 이번 선택에 전달된 목록에 없습니다.')
    return omitted_catalog[anchor]['itemId']


def _default_store():
    from paper_evidence import default_store
    return default_store


def _verified_store(store, paper_id, file_hash):
    store = _default_store() if store is None else store
    try:
        summary = store.status(paper_id)
    except KeyError:
        raise ValueError('paper_evidence_expired_or_missing') from None
    if not isinstance(summary, dict) or summary.get('paperId') != paper_id or summary.get('fileHash') != file_hash:
        raise ValueError('paper_evidence_hash_mismatch')
    return store


def _load_item_or_analysis(store, paper_id, file_hash, item_id):
    try:
        item = store.read_item(paper_id, item_id)
        kind = 'item'
    except KeyError:
        if not hasattr(store, 'read_analysis'):
            raise ValueError('paper_evidence_expired_or_missing') from None
        try:
            item = store.read_analysis(paper_id, item_id)
            kind = 'analysis'
        except KeyError:
            raise ValueError('paper_evidence_expired_or_missing') from None
    if not isinstance(item, dict):
        raise ValueError('paper_evidence_summary_invalid')
    if 'fileHash' in item and item.get('fileHash') != file_hash:
        raise ValueError('paper_evidence_hash_mismatch')
    return kind, item


def _compact_table(table):
    if not isinstance(table, dict):
        return None
    out = {}
    for key in ('rows', 'columns'):
        if key in table:
            out[key] = table[key]
    if isinstance(table.get('cells'), list):
        out['cells'] = copy.deepcopy(table['cells'])
    return out


def _matching_analyses(store, paper_id, file_hash, item):
    if not hasattr(store, 'list_analyses') or not hasattr(store, 'read_analysis'):
        return []
    listing = store.list_analyses(paper_id)
    if not isinstance(listing, dict) or listing.get('fileHash') != file_hash:
        raise ValueError('paper_evidence_hash_mismatch')
    matches = []
    for meta in listing.get('items', []):
        if meta.get('pageIndex') != item.get('pageIndex'):
            continue
        entry = store.read_analysis(paper_id, meta['analysisId'])
        if entry.get('fileHash') != file_hash:
            raise ValueError('paper_evidence_hash_mismatch')
        if _boxes_overlap(item.get('bbox'), entry.get('bbox')):
            matches.append(_format_analysis_record(entry))
    return matches


def _boxes_overlap(a, b):
    if not (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and len(a) == 4 and len(b) == 4):
        return False
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def _format_analysis_record(entry):
    from paper_evidence_blue import _analysis_context_entry
    data = entry.get('data') if isinstance(entry.get('data'), dict) else {}
    provenance = data.get('provenance') if isinstance(data.get('provenance'), dict) else {}
    method = provenance.get('method')
    native = provenance.get('vector') == 'pdf-native-path'
    context_entry = _analysis_context_entry(entry, entry.get('kind'), native, method)
    record = {'analysisId': context_entry.get('analysisId'), 'kind': context_entry.get('kind'),
              'pageIndex': context_entry.get('pageIndex'), 'bbox': context_entry.get('bbox')}
    if 'data' in context_entry:
        record['data'] = context_entry['data']
    return record


def _format_item_record(store, paper_id, file_hash, item_id, kind, item):
    if kind == 'analysis':
        return {'itemId': item_id, 'type': 'analysis', **_format_analysis_record(item)}
    record = {'itemId': item_id, 'type': item.get('type'), 'pageIndex': item.get('pageIndex'),
              'bbox': item.get('bbox'), 'caption': item.get('caption')}
    for key in ('provenance', 'classification', 'logicalTableId', 'partIndex',
                'partCount', 'continuedFromId', 'continuedIds', 'footnotes', 'units', 'logicalTable'):
        if key in item and item[key] not in (None, []):
            record[key] = copy.deepcopy(item[key])
    table = _compact_table(item.get('table'))
    if table is not None:
        record['table'] = table
    if item.get('type') == 'figure':
        analyses = _matching_analyses(store, paper_id, file_hash, item)
        if analyses:
            record['chartMetadata'] = analyses
    return record


def _fit_record_to_budget(records, record, max_chars):
    candidate = records + [record]
    if len(json.dumps(candidate, ensure_ascii=False)) <= max_chars:
        return candidate
    trimmed = copy.deepcopy(record)
    table = trimmed.get('table')
    if isinstance(table, dict) and isinstance(table.get('cells'), list):
        cells = table['cells']
        lo, hi, best = 0, len(cells), None
        while lo <= hi:
            mid = (lo + hi) // 2
            table['cells'] = cells[:mid]
            table['cellsTruncated'] = mid < len(cells)
            if len(json.dumps(records + [trimmed], ensure_ascii=False)) <= max_chars:
                best = copy.deepcopy(trimmed)
                lo = mid + 1
            else:
                hi = mid - 1
        if best is not None:
            return records + [best]
    minimal = {k: v for k, v in record.items() if k in ('itemId', 'type', 'pageIndex', 'bbox', 'caption', 'footnotes', 'units')}
    if len(json.dumps(records + [minimal], ensure_ascii=False)) <= max_chars:
        return records + [minimal]
    return records


def format_reread_items(paper_id, file_hash, item_ids, store=None, max_chars=MAX_REREAD_ITEMS_CHARS):
    """Load requested omitted items from EvidenceStore, verify fileHash, and bound to max_chars."""
    if not item_ids or max_chars <= 2:
        return []
    store = _verified_store(store, paper_id, file_hash)
    records = []
    for item_id in item_ids[:MAX_OMITTED_SELECTIONS]:
        kind, item = _load_item_or_analysis(store, paper_id, file_hash, item_id)
        record = _format_item_record(store, paper_id, file_hash, item_id, kind, item)
        updated = _fit_record_to_budget(records, record, max_chars)
        if len(updated) == len(records):
            break
        records = updated
    return records


def trim_reread_items(records, max_chars):
    """Shrink already-formatted rereadEvidenceItems to fit a tighter prompt budget."""
    kept = list(records)
    while kept and len(json.dumps(kept, ensure_ascii=False)) > max_chars:
        last = kept[-1]
        table = last.get('table') if isinstance(last, dict) else None
        if isinstance(table, dict) and table.get('cells'):
            table['cells'] = table['cells'][:len(table['cells']) // 2]
            table['cellsTruncated'] = True
        else:
            kept.pop()
    return kept


def _scientific_figure_ids(store, paper_id, file_hash):
    ids, offset = [], 0
    for _ in range(200):
        page = store.list_items(paper_id, kind='figure', page_index=None, offset=offset, limit=50)
        if not isinstance(page, dict) or page.get('fileHash') != file_hash:
            raise ValueError('paper_evidence_hash_mismatch')
        batch = page.get('items') or []
        for meta in batch:
            if meta.get('classification', 'scientific') != 'decorative' and isinstance(meta.get('id'), str):
                ids.append(meta['id'])
        nxt = page.get('nextOffset')
        if not batch or nxt is None or type(nxt) is not int or nxt <= offset:
            break
        offset = nxt
    return ids


def _decode_rendered_crop(rendered, paper_id, file_hash, fallback_page, fallback_bbox):
    if isinstance(rendered, (bytes, bytearray)):
        png = bytes(rendered)
        return png, hashlib.sha256(png).hexdigest(), fallback_page, fallback_bbox, None, None
    if not isinstance(rendered, dict):
        return None
    if rendered.get('paperId') not in (None, paper_id) or rendered.get('fileHash') != file_hash:
        raise ValueError('paper_evidence_hash_mismatch')
    raw_b64 = rendered.get('data')
    if not isinstance(raw_b64, str):
        return None
    png = base64.b64decode(raw_b64, validate=True)
    sha256 = hashlib.sha256(png).hexdigest()
    if rendered.get('sha256') and rendered['sha256'] != sha256:
        raise ValueError('visual_png_invalid')
    page_idx = rendered.get('pageIndex', fallback_page)
    clip = rendered.get('bbox', fallback_bbox)
    return png, sha256, page_idx, clip, rendered.get('width'), rendered.get('height')


def _png_dimensions(png):
    if len(png) < 24 or png[:8] != b'\x89PNG\r\n\x1a\n' or png[8:16] != b'\x00\x00\x00\rIHDR':
        raise ValueError('visual_png_invalid')
    return int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')


def _item_render_target(item):
    page_idx, raw_bbox = item.get('pageIndex'), item.get('bbox')
    if type(page_idx) is not int or page_idx < 0 or not isinstance(raw_bbox, (list, tuple)) or len(raw_bbox) != 4:
        return None
    if not (raw_bbox[2] > raw_bbox[0] and raw_bbox[3] > raw_bbox[1]):
        return None
    return page_idx, list(raw_bbox)


def _crop_ref_metadata(png, sha256, out_page, clip, width, height):
    w, h = _png_dimensions(png)
    if (width is not None and width != w) or (height is not None and height != h):
        raise ValueError('visual_png_invalid')
    if not (0 < w <= 4096 and 0 < h <= 4096 and w * h <= 8_000_000):
        return None
    validate_png(png, w, h)
    if not isinstance(clip, (list, tuple)) or len(clip) != 4 or clip[0] < 0 or clip[1] < 0:
        return None
    box_wh = [round(float(clip[0]), 3), round(float(clip[1]), 3),
              round(float(clip[2] - clip[0]), 3), round(float(clip[3] - clip[1]), 3)]
    if box_wh[2] <= 0 or box_wh[3] <= 0:
        return None
    return png, {'sha256': sha256, 'page': out_page + 1, 'bbox': box_wh}


def _validated_crop(store, paper_id, file_hash, item):
    target = _item_render_target(item)
    if target is None:
        return None
    page_idx, raw_bbox = target
    for dpi in _CROP_DPIS:
        try:
            rendered = store.render_region(paper_id, page_idx, bbox=raw_bbox, dpi=dpi)
        except ValueError as err:
            if str(err) == 'paper_evidence_hash_mismatch':
                raise
            return None
        decoded = _decode_rendered_crop(rendered, paper_id, file_hash, page_idx, raw_bbox)
        if decoded is None:
            return None
        png, sha256, out_page, clip, width, height = decoded
        if len(png) > MAX_PNG_BYTES:
            continue
        built = _crop_ref_metadata(png, sha256, out_page, clip, width, height)
        if built is not None:
            return built
    return None


def render_auto_visual_crops(paper_id, file_hash, item_ids, existing_images, existing_refs, store=None):
    """Render up to min(2, 6 - len(existing_images)) item crops and validate PNG + metadata."""
    room = min(MAX_AUTO_CROPS, MAX_VISUAL_IMAGES - len(existing_images))
    if room <= 0:
        return [], []
    store = _verified_store(store, paper_id, file_hash)
    candidates = _scientific_figure_ids(store, paper_id, file_hash) if item_ids is None else list(item_ids)
    seen_sha = {ref.get('sha256') for ref in existing_refs if isinstance(ref, dict) and ref.get('sha256')}
    crop_images, crop_refs = [], []
    for item_id in candidates:
        if len(crop_images) >= room:
            break
        _kind, item = _load_item_or_analysis(store, paper_id, file_hash, item_id)
        built = _validated_crop(store, paper_id, file_hash, item)
        if built is None:
            continue
        png, ref = built
        if ref['sha256'] in seen_sha:
            continue
        seen_sha.add(ref['sha256'])
        crop_images.append(png)
        crop_refs.append(ref)
    return crop_images, crop_refs
