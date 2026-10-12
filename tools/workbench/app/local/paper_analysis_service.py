"""Advisory, read-only PDF preflight inspection behind POST /api/paper/inspect (falsify.pdf-analysis-summary.v1).

Public API:
  validate_request(data) -> (source_bytes, source_sha256, patches) for an exact falsify.pdf-analysis-request.v1, else ValueError(code)
  analyze(request, *, runner=None) -> fixed public summary for a validated request; never raises
  inspect(data, *, runner=None) -> analyze(validate_request(data))
  unavailable_summary(source_sha256, patches) -> the same fixed schema with zero counts and status 'unavailable'
  capability() -> {available, schema} for /api/capabilities

The parent never imports PyMuPDF or the adapters. The exact source bytes go to a private temporary file read by a child of this
interpreter (-I isolated mode, minimal environment, fixed argv, no shell, 60 s timeout); the child loads the trusted local
adapters paper_inventory, pdf_object_probe and pdf_layout_probe by fixed absolute paths next to this file, rehashes the bytes and
prints one private envelope of counts and fixed codes. The parent validates that envelope strictly (exact keys, bounded
non-negative integers, booleans, the request's patch ids in order) and maps every layout reason outside the probe's allow-list to
'probe-error', so a tampered or faulty child cannot publish source text, fonts, coordinates, xrefs, occurrence ids, paths or
exception messages. The temporary copy is removed on success, error and timeout; nothing is logged.

Counts describe what the bounded probes inspected, not the whole paper: inventory.pages is the number of inspected pages and
objects.sharedImages counts returned image OCCURRENCES carrying the 'shared-xref' reason, not distinct resources. Layout is the
metrics-only fixed-area probe in the tight source region at a conservative pitch of 1.5 x the source font size: informational,
never rendering, scientific validity or editability. Docling structure is not run ('conversion_unconfigured'); nothing downloads
models or calls a model. Any failure gives the unavailable summary, which never blocks export or download.
"""
import base64
import binascii
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REQUEST_SCHEMA = 'falsify.pdf-analysis-request.v1'
SCHEMA = 'falsify.pdf-analysis-summary.v1'
ENVELOPE_SCHEMA = 'falsify.pdf-analysis-envelope.v1'
REQUEST_KEYS = frozenset(('schema', 'fileHash', 'file', 'patches'))
PATCH_KEYS = ('id', 'pageIndex', 'before', 'after')
INVENTORY_KEYS = ('pages', 'textLines', 'images', 'vectors', 'truncated')
OBJECT_KEYS = ('images', 'sharedImages', 'inlineImages', 'vectors', 'ambiguous', 'inspected', 'complete')
LIMITATIONS = ('hint-only', 'text-only-blue', 'no-object-export')
LINE_HEIGHT_FACTOR = 1.5   # informational pitch: wider than a usual 1.2 em leading, so one-line bands are never refused as overlapping
# Count caps mirror the adapters' own budgets: paper_inventory maxInventoryPages x maxInventoryItems, pdf_object_probe maxOccurrences.
LIMITS = {'maxPdfBytes': 25 * 1024 * 1024, 'maxPatches': 12, 'maxTextChars': 4000, 'maxPages': 10000, 'timeoutSeconds': 60,
    'maxStdinBytes': 1024 * 1024, 'maxStdoutBytes': 64 * 1024, 'maxInventoryPages': 64, 'maxInventoryItems': 64 * 2000,
    'maxOccurrences': 4000}
# Every reason pdf_layout_probe can emit, by status; anything else (or any other status) is published as unsupported/'probe-error'.
OVERFLOW_REASONS = frozenset(('height', 'unbreakable-width', 'slot-budget'))
UNSUPPORTED_REASONS = frozenset(('after-not-text', 'after-empty', 'after-too-long', 'invalid-bbox', 'invalid-font-size',
    'invalid-line-height', 'invalid-obstacles', 'too-many-obstacles', 'pymupdf-unavailable', 'font-unavailable',
    'font-metrics-unavailable', 'unsupported-character', 'missing-glyphs', 'line-bands-overlap', 'source-not-simple', 'invalid-edit',
    'source-font-not-found', 'source-font-ambiguous', 'source-font-type3', 'source-font-program-unreadable',
    'source-font-not-embedded', 'probe-error'))
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
HERE = Path(__file__).resolve().parent
WORKER = HERE / 'paper_analysis_service.py'
ADAPTERS = {name: HERE / (name + '.py') for name in ('paper_inventory', 'pdf_object_probe', 'pdf_layout_probe')}
_HEX = re.compile(r'[0-9a-f]{64}')
_ID = re.compile(r'[A-Za-z0-9_.-]{1,64}')

def _sha(data): return hashlib.sha256(data).hexdigest()
def _count(v, cap): return type(v) is int and 0 <= v <= cap
def _flag(v): return type(v) is bool

def _utf8(text):
    try: text.encode('utf-8')
    except UnicodeEncodeError: return False
    return True

def _patches(value):
    if not isinstance(value, list) or len(value) > LIMITS['maxPatches']: raise ValueError('invalid_patches')
    out = []
    for p in value:
        if not isinstance(p, dict) or set(p) != set(PATCH_KEYS) or not isinstance(p['id'], str) or not _ID.fullmatch(p['id']) \
                or type(p['pageIndex']) is not int or not 0 <= p['pageIndex'] < LIMITS['maxPages']: raise ValueError('invalid_patches')
        for k in ('before', 'after'):
            if not isinstance(p[k], str) or not p[k].strip() or len(p[k]) > LIMITS['maxTextChars'] or not _utf8(p[k]):
                raise ValueError('invalid_patches')
        out.append({k: p[k] for k in PATCH_KEYS})
    if len({p['id'] for p in out}) != len(out): raise ValueError('invalid_patches')
    return out

def validate_request(data):
    """(source_bytes, source_sha256, patches) for an exact request, else ValueError with a fixed code (never request text)."""
    if not isinstance(data, dict) or set(data) != REQUEST_KEYS or data['schema'] != REQUEST_SCHEMA: raise ValueError('invalid_request')
    sha, encoded = data['fileHash'], data['file']
    if not isinstance(sha, str) or not _HEX.fullmatch(sha): raise ValueError('invalid_file_hash')
    if not isinstance(encoded, str) or not encoded.isascii() or not 0 < len(encoded) <= 4 * -(-LIMITS['maxPdfBytes'] // 3):
        raise ValueError('invalid_file')
    try: source = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError): raise ValueError('invalid_file') from None
    if base64.b64encode(source).decode('ascii') != encoded or len(source) > LIMITS['maxPdfBytes'] or not source.startswith(b'%PDF-'):
        raise ValueError('invalid_file')
    if _sha(source) != sha: raise ValueError('source_hash_mismatch')
    return source, sha, _patches(data['patches'])

def _layout_entry(patch_id, status, reason):
    if status == 'fits' and reason is None: return {'id': patch_id, 'status': 'fits', 'reason': None}
    if isinstance(reason, str) and ((status == 'overflow' and reason in OVERFLOW_REASONS)
            or (status == 'unsupported' and reason in UNSUPPORTED_REASONS)):
        return {'id': patch_id, 'status': status, 'reason': reason}
    return {'id': patch_id, 'status': 'unsupported', 'reason': 'probe-error'}

def _summary(source_sha256, status, inventory, objects, layout):
    return {'schema': SCHEMA, 'sourceSha256': source_sha256, 'status': status, 'inventory': inventory, 'objects': objects,
        'layout': layout, 'structure': {'status': 'unavailable', 'reason': 'conversion_unconfigured'}, 'limits': list(LIMITATIONS)}

def _empty(keys): return {k: False if k in ('truncated', 'complete') else 0 for k in keys}

def unavailable_summary(source_sha256, patches):
    return _summary(source_sha256, 'unavailable', _empty(INVENTORY_KEYS), _empty(OBJECT_KEYS),
        [_layout_entry(p['id'], None, None) for p in patches])

def _section(value, keys, caps):
    """(available, counts) of a strictly well-formed envelope section, else None. Unavailable sections carry only zeros."""
    if not isinstance(value, dict) or set(value) != {'available', *keys} or not _flag(value['available']): return None
    counts = {}
    for k in keys:
        v = value[k]
        if not (_flag(v) if k in ('truncated', 'complete') else _count(v, caps.get(k, LIMITS['maxOccurrences']))): return None
        counts[k] = v
    if not value['available'] and counts != _empty(keys): return None
    return value['available'], counts

def _from_envelope(envelope, source_sha256, patches):
    """Fixed public summary from a child envelope bound to this source and these patches, else None."""
    if not isinstance(envelope, dict) or set(envelope) != {'schema', 'sourceSha256', 'inventory', 'objects', 'layout'} \
            or envelope['schema'] != ENVELOPE_SCHEMA or envelope['sourceSha256'] != source_sha256: return None
    items = LIMITS['maxInventoryItems']
    inventory = _section(envelope['inventory'], INVENTORY_KEYS, {'pages': LIMITS['maxInventoryPages'], 'textLines': items,
        'images': items, 'vectors': items})
    objects = _section(envelope['objects'], OBJECT_KEYS, {})
    layout = envelope['layout']
    if inventory is None or objects is None or not isinstance(layout, list) or len(layout) != len(patches): return None
    o = objects[1]
    if o['sharedImages'] > o['images'] or o['ambiguous'] + o['inspected'] > o['images'] + o['inlineImages'] + o['vectors']: return None
    entries = []
    for got, p in zip(layout, patches):
        if not isinstance(got, dict) or set(got) != {'id', 'status', 'reason'} or got['id'] != p['id']: return None
        entries.append(_layout_entry(p['id'], got['status'], got['reason']))
    ran = inventory[0] + objects[0]
    status = 'available' if ran == 2 and not inventory[1]['truncated'] and o['complete'] else 'partial' if ran else 'unavailable'
    return _summary(source_sha256, status, inventory[1], o, entries)

def _no_duplicates(items):
    out = {}
    for k, v in items:
        if k in out: raise ValueError('duplicate key')
        out[k] = v
    return out

def _no_constant(_name): raise ValueError('nonfinite JSON')

def default_runner(argv, *, input, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, input=input, cwd=cwd, env=env, timeout=timeout, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def _child_envelope(source, source_sha256, patches, runner):
    """The child's parsed envelope, else None. The private source copy never outlives this call."""
    if not sys.executable: return None
    workdir = None
    try:
        workdir = tempfile.mkdtemp(prefix='falsify-inspect-')
        path = Path(workdir) / 'source.pdf'
        with open(path, 'xb') as f: f.write(source)
        stdin = json.dumps({'source': str(path), 'sourceSha256': source_sha256, 'patches': patches}).encode('ascii')
        if len(stdin) > LIMITS['maxStdinBytes']: return None
        env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
        result = (runner or default_runner)([sys.executable, '-I', str(WORKER), '--worker'], input=stdin, cwd=workdir, env=env,
            timeout=LIMITS['timeoutSeconds'])
        raw = result.stdout or b''
        if result.returncode != 0 or not isinstance(raw, bytes) or len(raw) > LIMITS['maxStdoutBytes']: return None
        lines = [l for l in raw.decode('utf-8', 'strict').splitlines() if l.strip()]
        if len(lines) != 1: return None
        return json.loads(lines[0], object_pairs_hook=_no_duplicates, parse_constant=_no_constant)
    except Exception:   # timeout, OS, decode and JSON failures all become the same fixed unavailable summary
        return None
    finally:
        if workdir: shutil.rmtree(workdir, ignore_errors=True)

def analyze(request, *, runner=None):
    """Fixed public summary for a validate_request() result. Never raises; any failure is the unavailable summary."""
    source, source_sha256, patches = request
    try: summary = _from_envelope(_child_envelope(source, source_sha256, patches, runner), source_sha256, patches)
    except Exception: summary = None
    return summary or unavailable_summary(source_sha256, patches)

def inspect(data, *, runner=None): return analyze(validate_request(data), runner=runner)

def capability():
    """Offered when this interpreter can start the child and the adapters and PyMuPDF are installed. Absence disables only this
    advisory inspection, never export or download."""
    try: available = bool(sys.executable) and all(p.is_file() for p in ADAPTERS.values()) \
        and importlib.util.find_spec('pymupdf') is not None
    except (ImportError, ValueError, OSError): available = False
    return {'available': available, 'schema': SCHEMA}

# ---- child side (python -I paper_analysis_service.py --worker) ----

def _load_adapters():
    """The trusted adapters by fixed absolute paths next to this file (-I: nothing from the working directory, PYTHONPATH or user
    site). paper_inventory is registered first because pdf_layout_probe imports it by name."""
    modules = {}
    for name, path in ADAPTERS.items():
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        modules[name] = module
    return modules

def _inventory_counts(paper_inventory, source, page_count):
    try:
        report = paper_inventory.build_inventory(source)
        if report.get('status') != 'available': return {'available': False, **_empty(INVENTORY_KEYS)}
        pages = report['pages']
        cap = paper_inventory.LIMITS['maxInventoryPages']
        truncated = any(p['truncated'] for p in pages) or (page_count > len(pages) if page_count else len(pages) >= cap)
        return {'available': True, 'pages': len(pages), 'textLines': sum(len(p['text']) for p in pages),
            'images': sum(len(p['images']) for p in pages), 'vectors': sum(len(p['vectors']) for p in pages), 'truncated': truncated}
    except Exception:
        return {'available': False, **_empty(INVENTORY_KEYS)}

def _object_counts(probe):
    if probe.get('status') != 'available': return {'available': False, **_empty(OBJECT_KEYS)}
    occurrences = probe['occurrences']
    kinds = [o['kind'] for o in occurrences]
    return {'available': True, 'images': kinds.count('image'),
        'sharedImages': sum(o['kind'] == 'image' and 'shared-xref' in o['reasons'] for o in occurrences),
        'inlineImages': kinds.count('inline-image'), 'vectors': kinds.count('vector') + kinds.count('shading'),
        'ambiguous': sum(o['capability'] == 'ambiguous' for o in occurrences),
        'inspected': sum(o['capability'] == 'inspected' for o in occurrences), 'complete': bool(probe['complete'])}

def _layout_result(paper_inventory, pdf_layout_probe, source, patch):
    try:
        entry = paper_inventory.build_edit_plan(source, [patch])['edits'][0]
        size = entry['styles'][0]['size'] if entry['status'] == 'resolved' and len(entry['styles']) == 1 else None
        # Without one resolved style the source wrapper itself answers 'source-not-simple'; the pitch is then never used.
        result = pdf_layout_probe.propose_from_source(source, patch, size * LINE_HEIGHT_FACTOR if size else 1.0)
        return {'id': patch['id'], 'status': result['status'], 'reason': result['reason']}
    except Exception:
        return {'id': patch['id'], 'status': 'unsupported', 'reason': 'probe-error'}

def build_envelope(source, patches):
    """Private child envelope for the exact source bytes: counts and fixed codes only."""
    adapters = _load_adapters()
    try: probe = adapters['pdf_object_probe'].build_object_probe(source)
    except Exception: probe = {'status': 'unavailable'}
    try: objects = _object_counts(probe)
    except Exception: objects = {'available': False, **_empty(OBJECT_KEYS)}
    page_count = probe.get('pageCount') if objects['available'] else None
    return {'schema': ENVELOPE_SCHEMA, 'sourceSha256': _sha(source),
        'inventory': _inventory_counts(adapters['paper_inventory'], source, page_count), 'objects': objects,
        'layout': [_layout_result(adapters['paper_inventory'], adapters['pdf_layout_probe'], source, p) for p in patches]}

def _worker(out):
    request = json.loads(sys.stdin.buffer.read(LIMITS['maxStdinBytes'] + 1).decode('utf-8'))
    path = Path(request['source'])
    source = path.read_bytes() if path.stat().st_size <= LIMITS['maxPdfBytes'] else b''
    envelope = build_envelope(source, _patches(request['patches'])) if _sha(source) == request['sourceSha256'] else {}
    out.write(json.dumps(envelope) + '\n')

if __name__ == '__main__' and sys.argv[1:] == ['--worker']:
    # Only a private duplicate of fd 1 carries the envelope; fd 1 itself becomes devnull, so library chatter (PyMuPDF prints
    # recoverable 'MuPDF error: ...' lines on stdout) cannot turn a readable source into the unavailable summary.
    out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
    os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
    try: _worker(out)
    except Exception: out.write('{}\n')
    out.flush()
