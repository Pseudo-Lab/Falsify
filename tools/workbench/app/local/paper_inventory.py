"""Private, bounded, source-derived PDF inventory and selected-text edit plan, read with PyMuPDF (MuPDF).

Public API:
  build_edit_plan(source_bytes, edits) -> private plan {schema:'falsify.pdf-edit-plan.v1', sourceSha256, policy, status, edits}
  plan_isolated(source_path, source_sha256, edits, *, runner=None) -> the same plan built in a child process with a timeout
  validate_plan(plan, source_sha256, edits) -> strict copy of a well-formed plan bound to this source and selection, else None
  unavailable_plan(source_sha256, edits) -> plan in which every edit is 'unavailable'
  summarize(plan) -> fixed public summary {schema:'falsify.pdf-edit-plan-summary.v1', status, plannedEdits, resolvedEdits, policy}
  build_inventory(source_bytes, page_indices=None) -> private bounded page text/image/vector bbox inventory

Each plan edit: {id, pageIndex, beforeSha256, afterSha256, status, regions, styles}. status is resolved|ambiguous|unavailable;
regions are tight per-line [x0, y0, x1, y1] rectangles of the selected source characters in MuPDF points of the unrotated,
uncropped page (top-left origin); styles are the source {font, size, color} (color as integer RGB). Coordinates and styles come
only from the immutable source bytes, never from a request or an output. Anchoring normalizes white space only: signs, digits,
operators, hyphens and ligatures compare exactly. Repeated anchors, mixed styles, ligatures, non-horizontal text, rotated or
cropped pages and over-budget pages are never guessed: they stay 'ambiguous' or 'unavailable', and an unavailable plan never
blocks an export. The plan is private (it carries coordinates and font names, never document text) and must not be printed,
logged or returned; only summarize() is public. The inventory describes what exists and claims no ability to edit it.
Nothing here edits, repairs, flattens or writes a PDF.
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = 'falsify.pdf-edit-plan.v1'
SUMMARY_SCHEMA = 'falsify.pdf-edit-plan-summary.v1'
INVENTORY_SCHEMA = 'falsify.pdf-inventory.v1'
POLICY = 'document-consistency-text'
PLAN_STATUSES = ('resolved', 'partial', 'unavailable')
EDIT_STATUSES = ('resolved', 'ambiguous', 'unavailable')
EDIT_KEYS = ('id', 'pageIndex', 'beforeSha256', 'afterSha256', 'status', 'regions', 'styles')
LIMITS = {'maxFileBytes': 25 * 1024 * 1024, 'maxPages': 10000, 'maxEdits': 12, 'maxTextChars': 4000, 'maxPageChars': 200000,
    'maxPageSpans': 20000, 'maxRegions': 64, 'maxInventoryPages': 64, 'maxInventoryItems': 2000,
    'timeoutSeconds': 60, 'maxStdinBytes': 1024 * 1024, 'maxStdoutBytes': 512 * 1024}
ORIGIN_TOLERANCE = 0.01   # points; page box origin/size equality
PAGE_OVERHANG = 1.0       # points a font box may extend past the page box
MAX_REGION_WIDTH = 0.98   # fraction of page width: wider per-line regions count as page-wide
MAX_REGION_HEIGHT = 0.25  # fraction of page height: taller per-line regions are not tight
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
_HEX = re.compile(r'[0-9a-f]{64}')
_ID = re.compile(r'[A-Za-z0-9_.-]{1,64}')
_LIGATURE = re.compile('[ﬀ-ﭏ]')

class _OverBudget(Exception): pass

def _sha(data): return hashlib.sha256(data).hexdigest()
def _text_sha(text): return _sha(text.encode('utf-8'))

def _edit_list(edits):
    """The selected edits as given: exact id/pageIndex/before/after, bounded. Raises ValueError (never rewrites)."""
    if not isinstance(edits, (list, tuple)) or not 1 <= len(edits) <= LIMITS['maxEdits']: raise ValueError('edits')
    out = []
    for e in edits:
        if not isinstance(e, dict) or not isinstance(e.get('id'), str) or not _ID.fullmatch(e['id']) \
                or type(e.get('pageIndex')) is not int or not 0 <= e['pageIndex'] < LIMITS['maxPages']: raise ValueError('edit')
        for k in ('before', 'after'):
            if not isinstance(e.get(k), str) or not e[k].strip() or len(e[k]) > LIMITS['maxTextChars']: raise ValueError('edit text')
        out.append({k: e[k] for k in ('id', 'pageIndex', 'before', 'after')})
    if len({e['id'] for e in out}) != len(out): raise ValueError('edit ids')
    return out

def _entry(e, status='unavailable', regions=(), styles=()):
    return {'id': e['id'], 'pageIndex': e['pageIndex'], 'beforeSha256': _text_sha(e['before']), 'afterSha256': _text_sha(e['after']),
        'status': status, 'regions': [list(r) for r in regions], 'styles': [dict(s) for s in styles]}

def _plan(source_sha256, entries):
    resolved = sum(e['status'] == 'resolved' for e in entries)
    status = 'resolved' if resolved == len(entries) else 'unavailable' if resolved == 0 else 'partial'
    return {'schema': SCHEMA, 'sourceSha256': source_sha256, 'policy': POLICY, 'status': status, 'edits': entries}

def unavailable_plan(source_sha256, edits):
    return _plan(source_sha256, [_entry(e) for e in _edit_list(edits)])

def _page_supported(page):
    """Only identity pages: no rotation, MediaBox at the origin and CropBox equal to it, so page points are unambiguous."""
    m, c, pos = page.mediabox, page.cropbox, page.cropbox_position
    near = lambda a, b: abs(a - b) <= ORIGIN_TOLERANCE
    return page.rotation % 360 == 0 and near(m.x0, 0) and near(m.y0, 0) and near(pos.x, 0) and near(pos.y, 0) \
        and near(c.width, m.width) and near(c.height, m.height)

def _records(page, mupdf):
    """Reading-order characters (c, bbox, style, line key, horizontal) with None at every line boundary."""
    flags = mupdf.TEXT_PRESERVE_WHITESPACE | mupdf.TEXT_PRESERVE_LIGATURES | mupdf.TEXT_MEDIABOX_CLIP
    out, spans = [], 0
    for b, block in enumerate(page.get_text('rawdict', flags=flags).get('blocks', [])):
        if block.get('type') != 0: continue
        for n, line in enumerate(block.get('lines', [])):
            out.append(None)
            direction = tuple(line.get('dir') or ())
            horizontal = line.get('wmode', 0) == 0 and len(direction) == 2 and abs(direction[0] - 1) < 1e-6 and abs(direction[1]) < 1e-6
            for span in line.get('spans', []):
                spans += 1
                if spans > LIMITS['maxPageSpans']: raise _OverBudget
                style = (str(span.get('font', ''))[:128], round(float(span.get('size', 0)), 3), int(span.get('color', 0)) & 0xFFFFFF)
                for ch in span.get('chars', []):
                    out.append((ch.get('c', ''), tuple(ch.get('bbox', ())), style, (b, n), horizontal))
                    if len(out) > LIMITS['maxPageChars']: raise _OverBudget
    return out

def _normalized(records):
    """Page text with every white-space run (including line boundaries) as one space, and the record behind each char."""
    chars, owners, gap = [], [], False
    for i, r in enumerate(records):
        if r is None or not r[0].strip(): gap = True; continue
        if gap and chars: chars.append(' '); owners.append(None)
        gap = False
        chars.append(r[0]); owners.append(i)
    return ''.join(chars), owners

def _finite_box(box):
    return len(box) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box) and box[0] <= box[2] and box[1] <= box[3]

def _anchor(page, before, mupdf):
    """(status, regions, styles) for one selected Before on one source page; conservative, never guessed."""
    if not _page_supported(page): return 'unavailable', [], []
    needle = ' '.join(before.split())
    if _LIGATURE.search(needle): return 'unavailable', [], []
    try: records = _records(page, mupdf)
    except _OverBudget: return 'unavailable', [], []
    text, owners = _normalized(records)
    hits, start = [], 0
    while len(hits) < 2:
        k = text.find(needle, start)
        if k < 0: break
        hits.append(k); start = k + 1
    if not hits: return 'unavailable', [], []
    if len(hits) > 1: return 'ambiguous', [], []
    chosen = [records[i] for i in owners[hits[0]:hits[0] + len(needle)] if i is not None]
    if not chosen or any(not r[4] or _LIGATURE.search(r[0]) or not _finite_box(r[1]) for r in chosen): return 'unavailable', [], []
    styles = list(dict.fromkeys(r[2] for r in chosen))
    if len(styles) != 1: return 'unavailable', [], []   # mixed font/size/color: no single source style to reuse
    lines = {}
    for r in chosen:
        x0, y0, x1, y1 = r[1]
        box = lines.setdefault(r[3], [x0, y0, x1, y1])
        box[:] = [min(box[0], x0), min(box[1], y0), max(box[2], x1), max(box[3], y1)]
    width, height = page.rect.width, page.rect.height
    regions = [[round(v, 3) for v in box] for box in lines.values()]
    if len(regions) > LIMITS['maxRegions']: return 'unavailable', [], []
    for x0, y0, x1, y1 in regions:
        if not (x0 < x1 and y0 < y1 and x0 >= -PAGE_OVERHANG and y0 >= -PAGE_OVERHANG and x1 <= width + PAGE_OVERHANG
                and y1 <= height + PAGE_OVERHANG and x1 - x0 < MAX_REGION_WIDTH * width and y1 - y0 <= MAX_REGION_HEIGHT * height):
            return 'unavailable', [], []
    font, size, color = styles[0]
    if not font or not math.isfinite(size) or size <= 0: return 'unavailable', [], []
    return 'resolved', regions, [{'font': font, 'size': size, 'color': color}]

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

def _bytes(value): return bytes(value) if isinstance(value, (bytes, bytearray)) else b''

def build_edit_plan(source_bytes, edits):
    """Private plan for the selected edits against the exact source bytes. Raises ValueError only for malformed edits."""
    edits = _edit_list(edits)
    source = _bytes(source_bytes)
    opened = _open(source)
    if opened is None: return unavailable_plan(_sha(source), edits)
    mupdf, doc = opened
    entries = []
    try:
        for e in edits:
            try:
                if e['pageIndex'] >= doc.page_count: entries.append(_entry(e)); continue
                status, regions, styles = _anchor(doc[e['pageIndex']], e['before'], mupdf)
                entries.append(_entry(e, status, regions, styles))
            except Exception:
                entries.append(_entry(e))
    finally:
        doc.close()
    return _plan(_sha(source), entries)

def _number(v): return type(v) in (int, float) and math.isfinite(v)

def validate_plan(plan, source_sha256, edits):
    """Strict copy of a plan bound to this source hash and these exact selected edits, else None."""
    try:
        edits = _edit_list(edits)
        if not isinstance(plan, dict) or set(plan) != {'schema', 'sourceSha256', 'policy', 'status', 'edits'}: return None
        if plan['schema'] != SCHEMA or plan['policy'] != POLICY or not isinstance(source_sha256, str) or not _HEX.fullmatch(source_sha256) \
                or plan['sourceSha256'] != source_sha256 or not isinstance(plan['edits'], list) or len(plan['edits']) != len(edits): return None
        entries = []
        for got, e in zip(plan['edits'], edits):
            if not isinstance(got, dict) or set(got) != set(EDIT_KEYS) or got['status'] not in EDIT_STATUSES: return None
            expected = _entry(e)
            if any(type(got[k]) is not type(expected[k]) or got[k] != expected[k] for k in ('id', 'pageIndex', 'beforeSha256', 'afterSha256')): return None
            regions, styles = got['regions'], got['styles']
            if not isinstance(regions, list) or not isinstance(styles, list): return None
            if got['status'] == 'resolved':
                if not 1 <= len(regions) <= LIMITS['maxRegions'] or len(styles) != 1: return None
            elif regions or styles: return None
            for r in regions:
                if not isinstance(r, list) or len(r) != 4 or not all(_number(v) for v in r) or not (r[0] < r[2] and r[1] < r[3]): return None
            for s in styles:
                if not isinstance(s, dict) or set(s) != {'font', 'size', 'color'} or not isinstance(s['font'], str) or not 0 < len(s['font']) <= 128 \
                        or not _number(s['size']) or s['size'] <= 0 or type(s['color']) is not int or not 0 <= s['color'] <= 0xFFFFFF: return None
            entries.append(_entry(e, got['status'], regions, styles))
        copy = _plan(source_sha256, entries)
        return copy if copy['status'] == plan['status'] else None
    except (ValueError, TypeError, KeyError, AttributeError):
        return None

def summarize(plan):
    """Fixed public summary: status and counts only, never text, styles or coordinates."""
    if not isinstance(plan, dict) or plan.get('schema') != SCHEMA or plan.get('status') not in PLAN_STATUSES or not isinstance(plan.get('edits'), list):
        return {'schema': SUMMARY_SCHEMA, 'status': 'unavailable', 'plannedEdits': 0, 'resolvedEdits': 0, 'policy': POLICY}
    return {'schema': SUMMARY_SCHEMA, 'status': plan['status'], 'plannedEdits': len(plan['edits']),
        'resolvedEdits': sum(isinstance(e, dict) and e.get('status') == 'resolved' for e in plan['edits']), 'policy': POLICY}

def build_inventory(source_bytes, page_indices=None):
    """Private, bounded per-page bbox inventory (text lines, images, vector paths) for future adapters. Describes what
    exists only; nothing in it is claimed editable. Unreadable input gives status 'unavailable' with no pages."""
    source = _bytes(source_bytes)
    report = {'schema': INVENTORY_SCHEMA, 'sourceSha256': _sha(source), 'status': 'unavailable', 'pages': []}
    opened = _open(source)
    if opened is None: return report
    mupdf, doc = opened
    try:
        indices = range(doc.page_count) if page_indices is None else page_indices
        indices = [i for i in dict.fromkeys(indices) if type(i) is int and 0 <= i < doc.page_count][:LIMITS['maxInventoryPages']]
        cap = LIMITS['maxInventoryItems']
        boxes = lambda rects: [b for b in ([round(float(v), 3) for v in r] for r in rects) if _finite_box(b)]
        for i in indices:
            page = doc[i]
            text = boxes(l['bbox'] for b in page.get_text('dict', flags=mupdf.TEXT_MEDIABOX_CLIP).get('blocks', []) if b.get('type') == 0
                for l in b.get('lines', []))
            log = page.get_bboxlog()
            images = boxes(r for kind, r in log if kind in ('fill-image', 'fill-imgmask'))
            vectors = boxes(r for kind, r in log if kind in ('fill-path', 'stroke-path'))
            report['pages'].append({'pageIndex': i, 'width': round(page.rect.width, 3), 'height': round(page.rect.height, 3),
                'rotation': page.rotation % 360, 'supportedGeometry': _page_supported(page),
                'text': text[:cap], 'images': images[:cap], 'vectors': vectors[:cap], 'truncated': max(len(text), len(images), len(vectors)) > cap})
        report['status'] = 'available'
    except Exception:
        report['status'], report['pages'] = 'unavailable', []
    finally:
        doc.close()
    return report

def default_runner(argv, *, input, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, input=input, cwd=cwd, env=env, timeout=timeout, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def plan_isolated(source_path, source_sha256, edits, *, runner=None):
    """Production entry: build_edit_plan in a child of this interpreter (isolated mode, minimal environment, fixed argv,
    hard timeout) on the file's bytes, which must hash to source_sha256. Any failure is the unavailable plan."""
    edits = _edit_list(edits)
    fallback = unavailable_plan(source_sha256, edits)
    if not sys.executable: return fallback
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    try:
        stdin = json.dumps({'source': str(source_path), 'sourceSha256': source_sha256, 'edits': edits}).encode('utf-8')
        if len(stdin) > LIMITS['maxStdinBytes']: return fallback
        result = (runner or default_runner)([sys.executable, '-I', str(Path(__file__).resolve()), '--worker'],
            input=stdin, cwd=str(Path(source_path).parent), env=env, timeout=LIMITS['timeoutSeconds'])
        raw = result.stdout or b''
        if result.returncode != 0 or len(raw) > LIMITS['maxStdoutBytes']: return fallback
        lines = [l for l in raw.decode('utf-8', 'strict').splitlines() if l.strip()]
        return (validate_plan(json.loads(lines[0]), source_sha256, edits) if len(lines) == 1 else None) or fallback
    except (subprocess.TimeoutExpired, OSError, ValueError, UnicodeDecodeError):
        return fallback

def _worker():
    request = json.loads(sys.stdin.buffer.read(LIMITS['maxStdinBytes'] + 1).decode('utf-8'))
    path = Path(request['source'])
    source = path.read_bytes() if path.stat().st_size <= LIMITS['maxFileBytes'] else b''
    plan = build_edit_plan(source, request['edits']) if _sha(source) == request['sourceSha256'] else None
    sys.stdout.write(json.dumps(plan or {}) + '\n')

if __name__ == '__main__' and sys.argv[1:] == ['--worker']:
    try: _worker()
    except Exception: sys.stdout.write('{}\n')
