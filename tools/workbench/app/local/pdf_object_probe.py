"""Private, bounded, source-derived PDF object OCCURRENCE inventory, read with PyMuPDF (MuPDF). Experimental baseline for a
future object adapter: it describes placements and what is known about them; it claims no ability to edit any of them.

Public API:
  build_object_probe(source_bytes, page_indices=None) -> private probe {schema:'falsify.pdf-object-probe.v1', ...}
  synthetic_replace_unique_image(source_bytes, source_sha256, occurrence_id, replacement_png)
      -> SYNTHETIC-ONLY prototype result; refuses every source that is not a marked synthetic fixture

Probe: {schema, sourceSha256, policy:'inventory-only', status: available|unavailable, complete, pageCount, operations,
        pages: [{pageIndex, rotation, supportedGeometry, occurrences, truncated}],
        occurrences: [{id, pageIndex, kind, ordinal, xref, resourceNames, bbox, transform, sharedUse, capability, reasons}],
        resources: [{xref, placements, pageCount, pages, objectReferences, complete}]}
kind is image|inline-image|vector|shading. bbox/transform are MuPDF page-space values of the unrotated page (top-left origin).
One image XObject (xref) may be placed many times: sharedUse counts its rendered placements over the WHOLE source (forms
expanded) and the indirect references to it from every object, or says complete=False when a budget stopped the count.
capability is inspected|unsupported|ambiguous and is never an editability guarantee: 'inspected' only means this
occurrence is the sole use of a page-level image XObject on an identity page with no detected clip, form, mask, shared
use, repeated placement or page truncation. Nothing here writes a PDF except the synthetic prototype, which works on a
private copy.
Bounds are counts, sizes and loop budgets checked in Python; PyMuPDF still materializes each page's native result list
(image info, image listing, drawings, bbox log) before its length is checked, and no OS memory/time limit is applied.
"""
import hashlib
import json
import math
import re
import zlib

SCHEMA = 'falsify.pdf-object-probe.v1'
REPLACE_SCHEMA = 'falsify.pdf-object-replace-prototype.v1'
POLICY = 'inventory-only'
CAPABILITIES = ('inspected', 'unsupported', 'ambiguous')
REASONS = ('inline-image', 'vector-no-object-identity', 'shading-no-object-identity', 'shared-xref', 'shared-use-incomplete',
    'via-form', 'multiple-resource-names', 'resource-unresolved', 'soft-mask', 'transform-not-axis-aligned', 'clip-uncertain',
    'repeated-bbox', 'page-geometry', 'degenerate-bbox', 'page-truncated')
OPERATIONS = {'replaceImageOccurrence': 'unsupported', 'replaceSharedImageOccurrence': 'unsupported',
    'replaceUniqueImageXObject': 'synthetic-prototype-only'}
SYNTHETIC_KEYWORD = 'falsify-synthetic-object-fixture'
LIMITS = {'maxFileBytes': 25 * 1024 * 1024, 'maxPages': 10000, 'maxProbePages': 64, 'maxCountPages': 512,
    'maxObjects': 200000, 'maxPagePlacements': 2000, 'maxPlacements': 20000, 'maxPageDrawings': 5000,
    'maxPageOccurrences': 500, 'maxOccurrences': 4000, 'maxProofPages': 16, 'maxProofSide': 4000,
    'maxProofPagePixels': 4000000, 'maxProofPixels': 16000000, 'maxReplacementBytes': 16 * 1024 * 1024,
    'maxReplacementPixels': 2048 * 2048}
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
PNG_RGB8 = (b'\x08\x02\x00\x00\x00', b'\x08\x02\x00\x00\x01')   # bit depth 8, colour type 2 (RGB), deflate, filter 0, any interlace
ORIGIN_TOLERANCE = 0.01
AXIS_TOLERANCE = 1e-6
_REF = re.compile(rb'(\d+)\s+(\d+)\s+R\b')

def _sha(data): return hashlib.sha256(data).hexdigest()
def _bytes(value): return bytes(value) if isinstance(value, (bytes, bytearray)) else b''
def _round(values): return [round(float(v), 3) for v in values]
def _finite(values): return all(isinstance(v, (int, float)) and math.isfinite(v) for v in values)

def _open(source):
    """(module, document) for bounded PDF bytes, else None. The bytes are only read, never written back."""
    if len(source) > LIMITS['maxFileBytes'] or not source.startswith(b'%PDF-'): return None
    try:
        import pymupdf
    except ImportError:
        return None
    try: doc = pymupdf.open(stream=source, filetype='pdf')
    except Exception: return None
    if doc.needs_pass or not 0 < doc.page_count <= LIMITS['maxPages']:
        doc.close(); return None
    return pymupdf, doc

def _page_supported(page):
    m, c, pos = page.mediabox, page.cropbox, page.cropbox_position
    near = lambda a, b: abs(a - b) <= ORIGIN_TOLERANCE
    return page.rotation % 360 == 0 and near(m.x0, 0) and near(m.y0, 0) and near(pos.x, 0) and near(pos.y, 0) \
        and near(c.width, m.width) and near(c.height, m.height)

def _placements(doc):
    """{xref: {'placements': n, 'pages': [page indices]}} of rendered image placements over the source, and completeness.
    The count stops incomplete when the page, per-page placement or total placement budget is exceeded."""
    uses, total, count = {}, 0, min(doc.page_count, LIMITS['maxCountPages'])
    for pno in range(count):
        infos = doc[pno].get_image_info(xrefs=True)
        total += len(infos)
        if len(infos) > LIMITS['maxPagePlacements'] or total > LIMITS['maxPlacements']: return uses, False
        for info in infos:
            xref = info.get('xref') or 0
            if xref > 0:
                use = uses.setdefault(xref, {'placements': 0, 'pages': []})
                use['placements'] += 1
                if not use['pages'] or use['pages'][-1] != pno: use['pages'].append(pno)
    return uses, count == doc.page_count

def _references(doc, wanted):
    """Indirect references to each wanted xref from every object definition, and completeness under the object budget."""
    refs = dict.fromkeys(wanted, 0)
    n = doc.xref_length()
    if not wanted: return refs, True
    if n - 1 > LIMITS['maxObjects']: return refs, False
    for x in range(1, n):
        try: text = doc.xref_object(x, compressed=True).encode('latin-1', 'replace')
        except Exception: return refs, False
        for m in _REF.finditer(text):
            target = int(m.group(1))
            if target in refs: refs[target] += 1
    return refs, True

def _clips(drawings):
    """[(Rect scissor, plain rectangle path)] for every clip on the page."""
    out = []
    for d in drawings:
        if d.get('type') != 'clip' or d.get('scissor') is None: continue
        items = d.get('items') or []
        out.append((d['scissor'], len(items) == 1 and items[0][0] == 're'))
    return out

def _occurrence_id(source_sha256, page_index, kind, ordinal, xref, bbox, transform):
    key = json.dumps([source_sha256, page_index, kind, ordinal, xref, bbox, transform], separators=(',', ':'))
    return 'occ-' + _sha(key.encode('utf-8'))[:24]

def _image_reasons(mupdf, info, xref, listing, uses, uses_complete, refs, refs_complete, clips, repeated, geometry, truncated):
    reasons = []
    if not geometry: reasons.append('page-geometry')
    if truncated: reasons.append('page-truncated')
    bbox = mupdf.Rect(info['bbox'])
    if not _finite(info['bbox']) or bbox.is_empty: reasons.append('degenerate-bbox')
    a, b, c, d = (tuple(info.get('transform') or ()) + (0, 0, 0, 0))[:4]
    if abs(b) > AXIS_TOLERANCE or abs(c) > AXIS_TOLERANCE or a <= 0 or d <= 0: reasons.append('transform-not-axis-aligned')
    if xref == 0:
        return ['inline-image'] + reasons
    use = uses.get(xref, {'placements': 0})
    if use['placements'] != 1 or refs.get(xref, 0) > 1: reasons.append('shared-xref')
    if not uses_complete or not refs_complete: reasons.append('shared-use-incomplete')
    entries = [e for e in listing if e[0] == xref]
    if not entries: reasons.append('resource-unresolved')
    if any(e[9] != 0 for e in entries): reasons.append('via-form')
    if len({e[7] for e in entries}) > 1: reasons.append('multiple-resource-names')
    if any(e[1] != 0 for e in entries): reasons.append('soft-mask')
    if any(not (rect_path and scissor.contains(bbox)) for scissor, rect_path in clips): reasons.append('clip-uncertain')
    if repeated: reasons.append('repeated-bbox')
    return reasons

def _page_occurrences(mupdf, page, page_index, source_sha256, uses, uses_complete, refs, refs_complete):
    """(occurrences, truncated) for one page; images in content order, then vector paths, then shadings. When placements,
    resource listing or drawings exceed their page budget, clips/repeats are not fully known: images get 'page-truncated'."""
    geometry = _page_supported(page)
    infos, listing = page.get_image_info(xrefs=True), page.get_images(full=True)
    drawings = page.get_drawings(extended=True)
    placed, drawn = LIMITS['maxPagePlacements'], LIMITS['maxPageDrawings']
    truncated = len(infos) > placed or len(listing) > placed or len(drawings) > drawn
    infos, listing, drawings = infos[:placed], listing[:placed], drawings[:drawn]
    clips = _clips(drawings)
    boxes = [tuple(_round(i['bbox'])) for i in infos]
    out, ordinals, cap = [], {}, LIMITS['maxPageOccurrences']
    def add(kind, xref, bbox, transform, names, shared, capability, reasons):
        ordinal = ordinals[kind] = ordinals.get(kind, -1) + 1
        out.append({'id': _occurrence_id(source_sha256, page_index, kind, ordinal, xref, bbox, transform),
            'pageIndex': page_index, 'kind': kind, 'ordinal': ordinal, 'xref': xref, 'resourceNames': names, 'bbox': bbox,
            'transform': transform, 'sharedUse': shared, 'capability': capability, 'reasons': reasons})
    for info, box in zip(infos, boxes):
        if len(out) > cap: break
        xref = info.get('xref') or 0
        reasons = _image_reasons(mupdf, info, xref, listing, uses, uses_complete, refs, refs_complete, clips,
            boxes.count(box) > 1, geometry, truncated)
        shared = None
        if xref:
            use = uses.get(xref, {'placements': 0, 'pages': []})
            shared = {'placements': use['placements'], 'pageCount': len(use['pages']), 'objectReferences': refs.get(xref, 0),
                'complete': uses_complete and refs_complete}
        capability = 'unsupported' if 'inline-image' in reasons else 'ambiguous' if reasons else 'inspected'
        add('image' if xref else 'inline-image', xref, list(box), _round(info.get('transform') or ()),
            sorted({e[7] for e in listing if e[0] == xref}) if xref else [], shared, capability, reasons)
    for d in drawings:
        if len(out) > cap: break
        if d.get('type') in ('f', 's', 'fs') and d.get('rect') is not None:
            add('vector', 0, _round(d['rect']), None, [], None, 'unsupported', ['vector-no-object-identity'])
    for kind, rect in page.get_bboxlog():
        if len(out) > cap: break
        if kind == 'fill-shade': add('shading', 0, _round(rect), None, [], None, 'unsupported', ['shading-no-object-identity'])
    return out[:cap], truncated or len(out) > cap

def build_object_probe(source_bytes, page_indices=None):
    """Private bounded occurrence probe of the exact source bytes. Unreadable input gives status 'unavailable'."""
    source = _bytes(source_bytes)
    probe = {'schema': SCHEMA, 'sourceSha256': _sha(source), 'policy': POLICY, 'status': 'unavailable', 'complete': False,
        'pageCount': 0, 'operations': dict(OPERATIONS), 'pages': [], 'occurrences': [], 'resources': []}
    opened = _open(source)
    if opened is None: return probe
    mupdf, doc = opened
    try:
        indices = range(doc.page_count) if page_indices is None else page_indices
        indices = [i for i in dict.fromkeys(indices) if type(i) is int and 0 <= i < doc.page_count]
        truncated = len(indices) > LIMITS['maxProbePages']
        indices = indices[:LIMITS['maxProbePages']]
        uses, uses_complete = _placements(doc)
        wanted = set(uses)
        for i in indices: wanted.update(e[0] for e in doc[i].get_images(full=True)[:LIMITS['maxPagePlacements']])
        refs, refs_complete = _references(doc, wanted)
        seen = []
        for i in indices:
            occurrences, page_truncated = _page_occurrences(mupdf, doc[i], i, probe['sourceSha256'], uses, uses_complete,
                refs, refs_complete)
            room = LIMITS['maxOccurrences'] - len(probe['occurrences'])
            page_truncated = page_truncated or len(occurrences) > room
            occurrences = occurrences[:max(room, 0)]
            truncated = truncated or page_truncated
            probe['occurrences'] += occurrences
            probe['pages'].append({'pageIndex': i, 'rotation': doc[i].rotation % 360, 'supportedGeometry': _page_supported(doc[i]),
                'occurrences': len(occurrences), 'truncated': page_truncated})
            seen += [x for x in dict.fromkeys(o['xref'] for o in occurrences if o['xref']) if x not in seen]
        probe['resources'] = [{'xref': x, 'placements': uses.get(x, {}).get('placements', 0),
            'pageCount': len(uses.get(x, {}).get('pages', [])), 'pages': uses.get(x, {}).get('pages', [])[:LIMITS['maxProbePages']],
            'objectReferences': refs.get(x, 0), 'complete': uses_complete and refs_complete} for x in seen]
        probe.update(status='available', pageCount=doc.page_count, complete=uses_complete and refs_complete and not truncated)
    except Exception:
        probe.update(status='unavailable', complete=False, pages=[], occurrences=[], resources=[])
    finally:
        doc.close()
    return probe

def _refuse(result, reason):
    result.update(status='refused', reason=reason, output=None, outputSha256=None)
    return result

def _raster_refusal(doc):
    """'page-over-budget' unless every page's MediaBox and rendered rect are finite, positive and within the 72 dpi side,
    per-page pixel and whole-document pixel budgets, else None. Geometry only: run before any page of doc is rasterized."""
    side, total = LIMITS['maxProofSide'], 0
    for pno in range(doc.page_count):
        page = doc[pno]
        for r in (page.mediabox, page.rect):
            if not _finite(tuple(r)) or not (0 < r.width <= side and 0 < r.height <= side): return 'page-over-budget'
        pixels = (math.ceil(page.rect.width) + 1) * (math.ceil(page.rect.height) + 1)
        total += pixels
        if pixels > LIMITS['maxProofPagePixels'] or total > LIMITS['maxProofPixels']: return 'page-over-budget'
    return None

def _png_header(data):
    """(refusal, (width, height)) from the PNG signature and IHDR alone, before any decoder sees the bytes. Only a bounded,
    8-bit RGB (no alpha, no palette) PNG with a CRC-valid IHDR inside the pixel budget passes."""
    if len(data) > LIMITS['maxReplacementBytes']: return 'replacement-over-budget', None
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE) or data[8:16] != b'\x00\x00\x00\x0dIHDR' \
            or zlib.crc32(data[12:29]) != int.from_bytes(data[29:33], 'big') or data[24:29] not in PNG_RGB8:
        return 'replacement-invalid', None
    width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    if not (width and height): return 'replacement-invalid', None
    if width * height > LIMITS['maxReplacementPixels']: return 'replacement-over-budget', None
    return None, (width, height)

def _render_proof(mupdf, source, output, target):
    """Every page renders pixel-identically except inside the target placement (dilated 2 px), which must change.
    Callers must have passed both documents through _raster_refusal first."""
    a, b = mupdf.open(stream=source, filetype='pdf'), mupdf.open(stream=output, filetype='pdf')
    try:
        proof = {'pagesCompared': a.page_count, 'identicalPages': 0, 'outsideIdentical': False, 'targetChanged': False}
        if a.page_count != b.page_count: return proof
        for pno in range(a.page_count):
            pa, pb = a[pno].get_pixmap(alpha=False), b[pno].get_pixmap(alpha=False)
            same = pa.samples == pb.samples
            if pno != target['pageIndex']:
                proof['identicalPages'] += same
                continue
            x0, y0, x1, y1 = target['bbox']
            area = mupdf.IRect(math.floor(x0) - 2, math.floor(y0) - 2, math.ceil(x1) + 2, math.ceil(y1) + 2) & pa.irect
            pa.set_rect(area, (0,) * pa.n); pb.set_rect(area, (0,) * pb.n)   # throwaway renders: blank the placement
            proof['outsideIdentical'], proof['targetChanged'] = pa.samples == pb.samples, not same
        return proof
    finally:
        a.close(); b.close()

def _stable(probe, skip_id):
    return [(o['pageIndex'], o['kind'], o['xref'], o['bbox'], o['transform'], o['capability'])
        for o in probe['occurrences'] if o['id'] != skip_id]

def synthetic_replace_unique_image(source_bytes, source_sha256, occurrence_id, replacement_png):
    """SYNTHETIC-ONLY prototype: replace the samples of one image XObject that is used exactly once in the whole source.
    Refuses unless the source hashes to source_sha256, carries the synthetic fixture keyword, probes completely, and the
    occurrence is an 'inspected' image whose xref has one placement and one object reference. Shared xrefs are refused
    (per-occurrence isolation is unsupported). The replacement PNG header and every source/output page size are checked
    before any decode or raster. The output is returned only with a passing rendered proof; the source bytes are never
    modified. Not a public operation and not for real papers."""
    source = _bytes(source_bytes)
    replacement = _bytes(replacement_png)
    result = {'schema': REPLACE_SCHEMA, 'status': 'refused', 'reason': None, 'sourceSha256': _sha(source),
        'occurrenceId': occurrence_id if isinstance(occurrence_id, str) else None, 'occurrenceReasons': [], 'output': None,
        'outputSha256': None, 'proof': None}
    if not isinstance(source_sha256, str) or source_sha256 != result['sourceSha256']: return _refuse(result, 'source-identity')
    png_refusal, size = _png_header(replacement)
    if png_refusal: return _refuse(result, png_refusal)
    opened = _open(source)
    if opened is None: return _refuse(result, 'source-unreadable')
    mupdf, doc = opened
    try:
        if (doc.metadata or {}).get('keywords') != SYNTHETIC_KEYWORD: return _refuse(result, 'not-synthetic')
        if doc.page_count > LIMITS['maxProofPages']: return _refuse(result, 'over-budget')
        over = _raster_refusal(doc)
        if over: return _refuse(result, over)
        probe = build_object_probe(source)
        if probe['status'] != 'available' or not probe['complete']: return _refuse(result, 'probe-incomplete')
        target = next((o for o in probe['occurrences'] if o['id'] == occurrence_id), None)
        if target is None: return _refuse(result, 'occurrence-not-found')
        result['occurrenceReasons'] = list(target['reasons'])
        if target['kind'] != 'image': return _refuse(result, 'unsupported-kind')
        if 'shared-xref' in target['reasons']: return _refuse(result, 'shared-xref-requires-occurrence-isolation')
        shared = target['sharedUse']
        if target['capability'] != 'inspected' or shared['placements'] != 1 or shared['objectReferences'] != 1:
            return _refuse(result, 'occurrence-not-inspected')
        try: pix = mupdf.Pixmap(replacement)
        except Exception: return _refuse(result, 'replacement-invalid')
        if pix.alpha or pix.n != 3 or (pix.width, pix.height) != size \
                or not 0 < pix.width * pix.height <= LIMITS['maxReplacementPixels']:
            return _refuse(result, 'replacement-invalid')
        xref = target['xref']
        doc.update_object(xref, f'<</Type/XObject/Subtype/Image/Width {pix.width}/Height {pix.height}'
            '/ColorSpace/DeviceRGB/BitsPerComponent 8>>')
        doc.update_stream(xref, pix.samples, compress=True)
        output = doc.tobytes(no_new_id=True)
    except Exception:
        return _refuse(result, 'prototype-error')
    finally:
        doc.close()
    try:
        check = mupdf.open(stream=output, filetype='pdf')
        try: over = _raster_refusal(check)
        finally: check.close()
    except Exception:
        return _refuse(result, 'proof-error')
    if over: return _refuse(result, 'output-' + over)
    try:
        proof = _render_proof(mupdf, source, output, target)
        after = build_object_probe(output)
    except Exception:
        return _refuse(result, 'proof-error')
    moved = next((o for o in after['occurrences'] if o['pageIndex'] == target['pageIndex'] and o['kind'] == 'image'
        and o['xref'] == target['xref']), None)
    proof['otherOccurrencesUnchanged'] = after['complete'] and _stable(after, moved and moved['id']) == _stable(probe, target['id'])
    proof['targetPlacementUnchanged'] = bool(moved) and (moved['bbox'], moved['transform']) == (target['bbox'], target['transform'])
    proof['renderer'] = 'MuPDF ' + mupdf.VersionFitz
    result['proof'] = proof
    if not (proof['identicalPages'] == proof['pagesCompared'] - 1 and proof['outsideIdentical'] and proof['targetChanged']
            and proof['otherOccurrencesUnchanged'] and proof['targetPlacementUnchanged']):
        return _refuse(result, 'proof-failed')
    result.update(status='replaced', output=output, outputSha256=_sha(output))
    return result
