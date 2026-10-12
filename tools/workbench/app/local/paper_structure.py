"""Experimental, private, bounded normalization of a Docling structured-document payload onto the immutable source PDF.

Public API:
  normalize_docling(payload, source_bytes, *, payload_origin='supplied') -> private envelope {schema:'falsify.pdf-structure.v1', ...}
  summarize(envelope) -> fixed public summary {schema:'falsify.pdf-structure-summary.v1', status, reason, items, resolvedItems}
  convert_isolated(source_path, source_sha256, *, python, artifacts_path, runner=None) -> envelope from an opt-in local Docling
      conversion in a separate interpreter (the caller's own experimental venv), offline, fixed argv, hard timeout

The payload is a DoclingDocument (docling-core schema 1.x, as written by DoclingDocument.export_to_dict() or its JSON). Its
text, table, picture and caption items become regions in MuPDF points of the unrotated, uncropped SOURCE page (top-left
origin), with Docling's 1-based page_no mapped to a 0-based pageIndex and each bbox converted from its explicit
coord_origin (TOPLEFT or BOTTOMLEFT; a missing origin is refused, not defaulted). The source page box, rotation and crop are
read independently from the source bytes with PyMuPDF. Docling reports boxes in the rotated, cropped display frame, so only
identity pages (no rotation, CropBox = MediaBox at the origin) are mapped and their Docling size must match the source within
0.5 pt; other pages leave their items 'unavailable'. Malformed refs, ref cycles or shared children, wrong page counts or
sizes, a contradicting origin.binary_hash, NaN/Infinity or over-budget payloads refuse the whole payload with a fixed reason.

sourceSha256 binds the envelope to the exact source bytes it was normalized against. It does NOT prove that the payload was
produced from that source: a matching page geometry and origin.binary_hash (the low 64 bits of SHA-256, as Docling writes it)
are consistency checks a forged payload can also pass. Every envelope therefore carries authority 'structure-hint': its
regions locate source content for review and QA and authorize no edit. Item type, label, reading-order index, provenance
charspans and caption refs are preserved; no text, semantic confidence or editability is emitted or invented. The envelope
is private (coordinates); only summarize() is public. Nothing here edits, renders or writes a PDF, and nothing downloads
models: conversion needs an explicit interpreter with Docling installed and an explicit local artifacts directory.
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = 'falsify.pdf-structure.v1'
SUMMARY_SCHEMA = 'falsify.pdf-structure-summary.v1'
AUTHORITY = 'structure-hint'
STATUSES = ('available', 'partial', 'unavailable')
ORIGINS = ('supplied', 'local-conversion')
# Every envelope-level reason this module emits; summarize() publishes only these (never caller or document text).
REASONS = frozenset(('no_items', 'no_resolved_items', 'source_unreadable', 'source_hash_mismatch', 'payload_invalid',
    'over_budget', 'schema_unsupported', 'origin_hash_mismatch', 'page_count_mismatch', 'page_geometry_mismatch', 'ref_invalid',
    'ref_cycle', 'conversion_unconfigured', 'conversion_failed'))
LIMITS = {'maxFileBytes': 25 * 1024 * 1024, 'maxPages': 10000, 'maxPayloadBytes': 64 * 1024 * 1024, 'maxItems': 20000,
    'maxNodes': 50000, 'maxProv': 64, 'maxCaptions': 64, 'timeoutSeconds': 600, 'maxStdinBytes': 64 * 1024,
    'maxStdoutBytes': 64 * 1024 * 1024}
SIZE_TOLERANCE = 0.5   # points; Docling page size versus the source page box
ORIGIN_TOLERANCE = 0.01  # points; page box origin/size equality (as paper_inventory)
PAGE_OVERHANG = 1.0    # points a region may extend past the page box
ITEM_COLLECTIONS = ('texts', 'tables', 'pictures')
REF_COLLECTIONS = ('groups', 'texts', 'tables', 'pictures', 'key_value_items', 'form_items', 'field_regions', 'field_items')
# docling-core DocItemLabel values (docling_core/types/doc/labels.py)
LABELS = frozenset(('caption', 'chart', 'footnote', 'formula', 'list_item', 'page_footer', 'page_header', 'picture',
    'section_header', 'table', 'text', 'title', 'document_index', 'code', 'checkbox_selected', 'checkbox_unselected', 'form',
    'key_value_region', 'grading_scale', 'handwritten_text', 'empty_value', 'paragraph', 'reference', 'field_region',
    'field_heading', 'field_item', 'field_key', 'field_value', 'field_hint', 'marker'))
COLLECTION_LABELS = {'tables': frozenset(('table', 'document_index')), 'pictures': frozenset(('picture', 'chart'))}
NON_TEXT_LABELS = frozenset(('table', 'document_index', 'picture', 'chart'))
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
OFFLINE_ENV = {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1'}
_REF = re.compile(r'#/(body|furniture)|#/([a-z_]+)/(0|[1-9][0-9]{0,8})')
_VERSION = re.compile(r'1\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})')
_HEX = re.compile(r'[0-9a-f]{64}')
_U64 = 0xFFFFFFFFFFFFFFFF

class _Reject(Exception):
    """The whole payload is refused; args[0] is a fixed reason code."""

def _sha(data): return hashlib.sha256(data).hexdigest()
def _int(v): return type(v) is int
def _num(v): return type(v) in (int, float) and math.isfinite(v)

def _envelope(source_sha256, status, reason, origin, payload_sha256=None, version=None, checks=None, pages=(), items=()):
    return {'schema': SCHEMA, 'sourceSha256': source_sha256, 'payloadSha256': payload_sha256, 'payloadOrigin': origin,
        'producer': {'name': 'docling', 'schemaName': 'DoclingDocument', 'version': version}, 'authority': AUTHORITY,
        'status': status, 'reason': reason, 'checks': dict(checks or {}), 'pages': list(pages), 'items': list(items)}

def unavailable(source_sha256, reason, *, payload_origin='supplied'):
    return _envelope(source_sha256, 'unavailable', reason, payload_origin if payload_origin in ORIGINS else 'supplied')

def _no_constant(name): raise ValueError(name)

def _finite_float(text):
    value = float(text)
    if not math.isfinite(value): raise ValueError(text)
    return value

def _load(payload):
    """(object, SHA-256 of its canonical JSON) for a bounded JSON object without NaN/Infinity, else _Reject."""
    if isinstance(payload, (bytes, bytearray, str)):
        raw = payload.encode('utf-8') if isinstance(payload, str) else bytes(payload)
        if len(raw) > LIMITS['maxPayloadBytes']: raise _Reject('over_budget')
        try: payload = json.loads(raw.decode('utf-8'), parse_constant=_no_constant, parse_float=_finite_float)
        except (ValueError, UnicodeDecodeError, RecursionError): raise _Reject('payload_invalid')
    if not isinstance(payload, dict): raise _Reject('payload_invalid')
    try: canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False, ensure_ascii=False).encode('utf-8')
    except (ValueError, TypeError, RecursionError): raise _Reject('payload_invalid')
    if len(canonical) > LIMITS['maxPayloadBytes']: raise _Reject('over_budget')
    return payload, _sha(canonical)

def _geometry(page):
    """(width, height, identity) of the unrotated source MediaBox; identity is paper_inventory's supported-page rule."""
    m, c, pos = page.mediabox, page.cropbox, page.cropbox_position
    near = lambda a, b: abs(a - b) <= ORIGIN_TOLERANCE
    identity = page.rotation % 360 == 0 and near(m.x0, 0) and near(m.y0, 0) and near(pos.x, 0) and near(pos.y, 0) \
        and near(c.width, m.width) and near(c.height, m.height)
    return float(m.width), float(m.height), identity

def _source_pages(source):
    """[(width, height, identity)] per page of bounded readable PDF bytes, else None. The bytes are only read."""
    if len(source) > LIMITS['maxFileBytes'] or not source.startswith(b'%PDF-'): return None
    try:
        import pymupdf
    except ImportError:
        return None
    try: doc = pymupdf.open(stream=source, filetype='pdf')
    except Exception: return None
    try:
        if doc.needs_pass or not 0 < doc.page_count <= LIMITS['maxPages']: return None
        return [_geometry(doc[i]) for i in range(doc.page_count)]
    except Exception:
        return None
    finally:
        doc.close()

def _origin_check(doc, source_sha256):
    """'matched' or 'absent'; a present origin that contradicts the source rejects. Matching proves nothing about provenance."""
    origin = doc.get('origin')
    if origin is None: return 'absent'
    if not isinstance(origin, dict) or origin.get('mimetype', 'application/pdf') != 'application/pdf': raise _Reject('payload_invalid')
    if 'binary_hash' not in origin: return 'absent'
    value = origin['binary_hash']
    if isinstance(value, str) and _HEX.fullmatch(value): value = int(value, 16) & _U64   # docling-core's own hex parsing
    if not _int(value) or value != int(source_sha256, 16) & _U64: raise _Reject('origin_hash_mismatch')
    return 'matched'

def _pages(doc, source_pages):
    """({page_no: (docling height, identity, source width, source height)}, public page entries, any size compared)."""
    pages = doc.get('pages')
    if not isinstance(pages, dict): raise _Reject('payload_invalid')
    if len(pages) > len(source_pages): raise _Reject('page_count_mismatch')
    out, entries, compared = {}, [], False
    for key, page in pages.items():
        if not isinstance(page, dict) or not _int(page.get('page_no')) or type(key) not in (str, int) or str(key) != str(page['page_no']):
            raise _Reject('payload_invalid')
        page_no, size = page['page_no'], page.get('size')
        if not 1 <= page_no <= len(source_pages): raise _Reject('page_count_mismatch')
        if page_no in out or not isinstance(size, dict) or not all(_num(size.get(k)) and size[k] > 0 for k in ('width', 'height')):
            raise _Reject('payload_invalid')
        width, height, identity = source_pages[page_no - 1]
        if identity:
            if abs(size['width'] - width) > SIZE_TOLERANCE or abs(size['height'] - height) > SIZE_TOLERANCE:
                raise _Reject('page_geometry_mismatch')
            compared = True
        out[page_no] = (float(size['height']), identity, width, height)
        entries.append({'pageIndex': page_no - 1, 'pageNo': page_no, 'width': round(width, 3), 'height': round(height, 3),
            'supportedGeometry': identity})
    return out, sorted(entries, key=lambda e: e['pageIndex']), compared

def _collections(doc):
    cols, total = {}, 0
    for name in REF_COLLECTIONS:
        items = doc.get(name, [])
        if not isinstance(items, list): raise _Reject('payload_invalid')
        total += len(items)
        if total > LIMITS['maxItems']: raise _Reject('over_budget')
        for i, item in enumerate(items):
            if not isinstance(item, dict) or item.get('self_ref') != f'#/{name}/{i}': raise _Reject('ref_invalid')
        cols[name] = items
    return cols

def _ref(value, cols):
    """(collection, index) of a resolvable Docling RefItem {'$ref': '#/texts/3'}; roots and anything else reject."""
    if not isinstance(value, dict) or set(value) != {'$ref'} or not isinstance(value['$ref'], str): raise _Reject('ref_invalid')
    m = _REF.fullmatch(value['$ref'])
    if not m or m.group(1) or m.group(2) not in cols or int(m.group(3)) >= len(cols[m.group(2)]): raise _Reject('ref_invalid')
    return m.group(2), int(m.group(3))

def _read_order(doc, cols):
    """Preorder index of every text/table/picture reachable from body, then furniture. A node reached twice (a cycle or a
    shared child) rejects the payload: which parent is meant is never guessed."""
    order, seen, nodes = {}, set(), 0
    for root in ('body', 'furniture'):
        node = doc.get(root)
        if node is None and root == 'furniture': continue
        if not isinstance(node, dict) or node.get('self_ref') != f'#/{root}': raise _Reject('payload_invalid')
        stack = [node]
        while stack:
            node = stack.pop()
            ref = None if node.get('self_ref') in ('#/body', '#/furniture') else _ref({'$ref': node['self_ref']}, cols)
            if ref and ref[0] in ITEM_COLLECTIONS: order[ref] = len(order)
            children = node.get('children', [])
            if not isinstance(children, list): raise _Reject('ref_invalid')
            refs = [_ref(c, cols) for c in children]
            nodes += len(refs)
            if nodes > LIMITS['maxNodes']: raise _Reject('over_budget')
            for child in reversed(refs):
                if child in seen: raise _Reject('ref_cycle')
                seen.add(child)
                stack.append(cols[child[0]][child[1]])
    return order

def _region(prov, pages, page_count):
    """{'pageIndex', 'bbox', 'charspan'} in source MuPDF points, else a fixed reason code."""
    if not isinstance(prov, dict) or not _int(prov.get('page_no')): return 'provenance'
    page_no = prov['page_no']
    if not 1 <= page_no <= page_count: raise _Reject('page_count_mismatch')
    if page_no not in pages: return 'page_missing'
    docling_height, identity, width, height = pages[page_no]
    if not identity: return 'page_geometry'
    box = prov.get('bbox')
    if not isinstance(box, dict) or not all(_num(box.get(k)) for k in 'ltrb'): return 'bbox'
    if box.get('coord_origin') == 'TOPLEFT': y0, y1 = box['t'], box['b']
    elif box.get('coord_origin') == 'BOTTOMLEFT': y0, y1 = docling_height - box['t'], docling_height - box['b']
    else: return 'bbox'
    x0, x1 = box['l'], box['r']
    if not (x0 < x1 and y0 < y1) or x0 < -PAGE_OVERHANG or y0 < -PAGE_OVERHANG or x1 > width + PAGE_OVERHANG \
            or y1 > height + PAGE_OVERHANG: return 'bbox'
    span = prov.get('charspan')
    if not isinstance(span, (list, tuple)) or len(span) != 2 or not all(_int(v) and v >= 0 for v in span) or span[0] > span[1]:
        return 'provenance'
    return {'pageIndex': page_no - 1, 'bbox': [round(float(v), 3) for v in (x0, y0, x1, y1)], 'charspan': list(span)}

def _item(collection, index, item, order, pages, page_count, cols):
    label = item.get('label')
    kind = {'tables': 'table', 'pictures': 'picture'}.get(collection, 'caption' if label == 'caption' else 'text')
    entry = {'ref': f'#/{collection}/{index}', 'type': kind, 'label': label if label in LABELS else None,
        'readOrder': order.get((collection, index)), 'status': 'unavailable', 'reason': None, 'regions': [], 'captionRefs': []}
    if collection in COLLECTION_LABELS:
        captions = item.get('captions', [])
        if not isinstance(captions, list): raise _Reject('ref_invalid')
        if len(captions) > LIMITS['maxCaptions']: raise _Reject('over_budget')
        refs = [_ref(c, cols) for c in captions]
        if any(r[0] != 'texts' for r in refs): raise _Reject('ref_invalid')
        entry['captionRefs'] = [f'#/{c}/{i}' for c, i in refs]
    prov = item.get('prov', [])
    if not isinstance(prov, list): raise _Reject('payload_invalid')
    if len(prov) > LIMITS['maxProv']: raise _Reject('over_budget')
    if label not in LABELS or label not in COLLECTION_LABELS.get(collection, LABELS - NON_TEXT_LABELS): entry['reason'] = 'label'
    elif not prov: entry['reason'] = 'no_provenance'
    else:
        regions = [_region(p, pages, page_count) for p in prov]
        reason = next((r for r in regions if isinstance(r, str)), None)
        if reason: entry['reason'] = reason
        else: entry['status'], entry['regions'] = 'resolved', regions
    return entry

def normalize_docling(payload, source_bytes, *, payload_origin='supplied'):
    """Private structure envelope for a Docling payload against the exact source bytes. Never raises for bad input."""
    source = bytes(source_bytes) if isinstance(source_bytes, (bytes, bytearray)) else b''
    source_sha256, origin = _sha(source), payload_origin if payload_origin in ORIGINS else 'supplied'
    source_pages = _source_pages(source)
    if source_pages is None: return unavailable(source_sha256, 'source_unreadable', payload_origin=origin)
    try:
        doc, payload_sha256 = _load(payload)
        version = doc.get('version')
        if doc.get('schema_name') != 'DoclingDocument' or not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise _Reject('schema_unsupported')
        checks = {'originHash': _origin_check(doc, source_sha256)}
        pages, page_entries, compared = _pages(doc, source_pages)
        checks['pageGeometry'] = 'matched' if compared else 'unchecked'
        cols = _collections(doc)
        order = _read_order(doc, cols)
        items = [_item(c, i, item, order, pages, len(source_pages), cols) for c in ITEM_COLLECTIONS for i, item in enumerate(cols[c])]
    except _Reject as e:
        return unavailable(source_sha256, e.args[0], payload_origin=origin)
    except (TypeError, ValueError, KeyError, AttributeError, RecursionError):
        return unavailable(source_sha256, 'payload_invalid', payload_origin=origin)
    items.sort(key=lambda e: (e['readOrder'] is None, e['readOrder'] or 0, ITEM_COLLECTIONS.index(e['ref'].split('/')[1])))
    resolved = sum(e['status'] == 'resolved' for e in items)
    status = 'available' if items and resolved == len(items) else 'partial' if resolved else 'unavailable'
    reason = None if resolved else 'no_items' if not items else 'no_resolved_items'
    return _envelope(source_sha256, status, reason, origin, payload_sha256, version, checks, page_entries, items)

def summarize(envelope):
    """Fixed public summary: status, an allow-listed reason code (REASONS) and counts only, never coordinates, refs or text.
    An envelope with any other reason value (free text, list, dict, ...) is not one this module produced: envelope_invalid."""
    reason = envelope.get('reason') if isinstance(envelope, dict) else None
    if not isinstance(envelope, dict) or envelope.get('schema') != SCHEMA or envelope.get('authority') != AUTHORITY \
            or envelope.get('status') not in STATUSES or not isinstance(envelope.get('items'), list) \
            or not (reason is None or (isinstance(reason, str) and reason in REASONS)):
        return {'schema': SUMMARY_SCHEMA, 'status': 'unavailable', 'reason': 'envelope_invalid', 'items': 0, 'resolvedItems': 0}
    return {'schema': SUMMARY_SCHEMA, 'status': envelope['status'], 'reason': reason,
        'items': len(envelope['items']), 'resolvedItems': sum(isinstance(e, dict) and e.get('status') == 'resolved' for e in envelope['items'])}

def default_runner(argv, *, input, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, input=input, cwd=cwd, env=env, timeout=timeout, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def convert_isolated(source_path, source_sha256, *, python, artifacts_path, runner=None):
    """Opt-in real conversion. `python` is an interpreter that already has Docling installed (a separate experimental venv,
    never this app's) and `artifacts_path` a local directory of already downloaded Docling models; neither has a default.
    The child runs this file in isolated mode with a minimal environment forced offline (no model download), fixed argv and
    a hard timeout, converts the exact hashed bytes without OCR or remote services, and prints export_to_dict(). The parent
    normalizes that output against the bytes it hashed itself. Any failure is the unavailable envelope."""
    if not isinstance(source_sha256, str) or not _HEX.fullmatch(source_sha256): raise ValueError('source_sha256')
    fail = lambda reason: unavailable(source_sha256, reason, payload_origin='local-conversion')
    try:
        if not python or not artifacts_path or not Path(python).is_file() or not Path(artifacts_path).is_dir():
            return fail('conversion_unconfigured')
        path = Path(source_path).resolve()
        if path.stat().st_size > LIMITS['maxFileBytes']: return fail('over_budget')
        source = path.read_bytes()
    except (OSError, TypeError, ValueError):
        return fail('source_unreadable')
    if _sha(source) != source_sha256: return fail('source_hash_mismatch')
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    env.update(OFFLINE_ENV)
    stdin = json.dumps({'source': str(path), 'sourceSha256': source_sha256, 'artifactsPath': str(Path(artifacts_path).resolve())}).encode('utf-8')
    if len(stdin) > LIMITS['maxStdinBytes']: return fail('over_budget')
    try:
        result = (runner or default_runner)([str(python), '-I', str(Path(__file__).resolve()), '--docling-worker'],
            input=stdin, cwd=str(path.parent), env=env, timeout=LIMITS['timeoutSeconds'])
        raw = (result.stdout or b'').strip()
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return fail('conversion_failed')
    if result.returncode != 0 or not raw or len(raw) > LIMITS['maxStdoutBytes'] or b'\n' in raw: return fail('conversion_failed')
    return normalize_docling(raw, source, payload_origin='local-conversion')

def _docling_worker():
    """Child of convert_isolated, run by the caller's Docling interpreter. Converts only bytes that hash as requested."""
    from io import BytesIO
    request = json.loads(sys.stdin.buffer.read(LIMITS['maxStdinBytes'] + 1).decode('utf-8'))
    path, artifacts = Path(request['source']), Path(request['artifactsPath'])
    if path.stat().st_size > LIMITS['maxFileBytes'] or not artifacts.is_dir(): raise SystemExit(2)
    data = path.read_bytes()
    if _sha(data) != request['sourceSha256']: raise SystemExit(2)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling_core.types.io import DocumentStream
    options = PdfPipelineOptions(artifacts_path=str(artifacts), do_ocr=False, enable_remote_services=False, allow_external_plugins=False)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(DocumentStream(name='source.pdf', stream=BytesIO(data)), raises_on_error=True,
        max_num_pages=LIMITS['maxPages'], max_file_size=LIMITS['maxFileBytes'])
    sys.stdout.write(json.dumps(result.document.export_to_dict(), allow_nan=False) + '\n')

if __name__ == '__main__' and sys.argv[1:] == ['--docling-worker']:
    try: _docling_worker()
    except SystemExit: raise
    except Exception: raise SystemExit(1)
