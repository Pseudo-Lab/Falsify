"""Manual single-occurrence image replacement behind POST /api/paper/images and /api/paper/images/export.

Public API:
  validate_list_request(data) -> (source_bytes, source_sha256) for an exact falsify.image-list-request.v1, else ValueError(code)
  validate_export_request(data) -> (source_bytes, source_sha256, occurrence_id, replacement_png) for an exact
      falsify.image-export-request.v1 (consent true, PNG signature/IHDR/chunk layout checked BEFORE any decode), else ValueError(code)
  list_images(request, *, runner=None) -> falsify.image-list.v1 rebuilt from strictly validated child output, else ImageEditError
  export_image(request, *, runner=None) -> falsify.image-export.v1 with the output hash recomputed here, else ImageEditError
  capability() -> {available, schema} for /api/capabilities (imageEditor)

The parent never imports the engine, PyMuPDF, pikepdf or Pillow and never decodes an image. Validation here is bytes-only: canonical
base64, size caps, the source hash and the PNG header. The exact bytes go to a private temporary directory read by a child of this
interpreter (-I isolated mode, minimal environment, fixed argv, no shell, 90 s timeout); the child loads the trusted engine
image_occurrence_editor.py by its fixed absolute path next to this file, rehashes both inputs, and writes the list JSON or the output
PDF to fixed names in that directory plus one small private envelope on stdout. The parent checks file sizes before reading,
recomputes every hash, accepts only the exact public shapes and fixed reason codes, and rebuilds the response from validated
fields, so a faulty child cannot publish source text, paths, fonts or exception messages. The directory is removed on success,
error and timeout. Native allocations happen in the child but are not claimed OS-isolated; nothing is logged and no model is called.

Errors are ImageEditError(status, code, reason): 503 image_editor_unavailable (engine or dependency absent), 422 image_edit_rejected
with one fixed reason (the engine refused this source or occurrence), 504 image_edit_timeout, 500 image_edit_failed (anything else).
"""
import base64
import binascii
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

LIST_REQUEST_SCHEMA = 'falsify.image-list-request.v1'
LIST_SCHEMA = 'falsify.image-list.v1'
EXPORT_REQUEST_SCHEMA = 'falsify.image-export-request.v1'
EXPORT_SCHEMA = 'falsify.image-export.v1'
REPORT_SCHEMA = 'falsify.image-edit-report.v1'
ENVELOPE_SCHEMA = 'falsify.image-edit-envelope.v1'
FILENAME = 'falsify-image-experiment.pdf'
LIST_LIMITS = ('single-occurrence', 'manual-image', 'text-only-blue')
REPORT_LIMITS = ('engine-render-check', 'domain-review-pending', 'text-only-blue')
LIST_REQUEST_KEYS = frozenset(('schema', 'fileHash', 'file'))
EXPORT_REQUEST_KEYS = frozenset(('schema', 'fileHash', 'file', 'occurrenceId', 'replacement', 'consent'))
OCCURRENCE_KEYS = ('id', 'pageIndex', 'bbox', 'width', 'height', 'shared', 'editable', 'reason', 'thumbnail')
REPORT_KEYS = ('schema', 'sourceSha256', 'occurrenceId', 'outputSha256', 'pageIndex', 'bbox', 'changedOccurrences', 'check', 'limits')
# Fixed per-occurrence reasons of the list contract.
REASONS = frozenset(('form-image', 'inline-image', 'rotated-page', 'cropped-page', 'clipped-image', 'transparency',
    'unsupported-transform', 'overlapping-content', 'malformed-pdf', 'scan-limit', 'dependency-unavailable'))
# Engine refusals published on 422; any other engine code is published as 'engine-error'.
EXPORT_REASONS = REASONS | frozenset(('occurrence-not-found', 'not-editable', 'replacement-transparent', 'replacement-invalid',
    'replacement-too-large', 'output-too-large', 'check-failed', 'no-op', 'engine-error'))
LIMITS = {'maxPdfBytes': 25 * 1024 * 1024, 'maxOutputBytes': 64 * 1024 * 1024, 'maxPngBytes': 4 * 1024 * 1024,
    'maxPngPixels': 4_000_000, 'maxPngSide': 8192, 'maxOccurrences': 256, 'maxPages': 64, 'maxThumbnailSide': 320,
    'maxThumbnailBytes': 256 * 1024, 'maxListJsonBytes': 16 * 1024 * 1024, 'timeoutSeconds': 90, 'maxStdinBytes': 4096,
    'maxStdoutBytes': 64 * 1024, 'maxCoordinate': 100_000, 'maxImageSide': 1 << 20}
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
DEPENDENCIES = ('pymupdf', 'pikepdf', 'PIL')
HERE = Path(__file__).resolve().parent
WORKER = HERE / 'image_edit_service.py'
ENGINE = HERE / 'image_occurrence_editor.py'
SOURCE_NAME, REPLACEMENT_NAME, OUTPUT_NAME, LIST_NAME = 'source.pdf', 'replacement.png', 'output.pdf', 'list.json'
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
PNG_DEPTHS = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
_HEX = re.compile(r'[0-9a-f]{64}')
_CHUNK = re.compile(rb'[A-Za-z]{4}')

class ImageEditError(Exception):
    """Fixed public failure: never carries request bytes, engine text, paths or exception messages."""
    def __init__(self, status, code, reason=None):
        super().__init__(code)
        self.status, self.code, self.reason = status, code, reason
    def payload(self):
        return {'error': self.code, 'reason': self.reason} if self.reason is not None else {'error': self.code}

def _sha(data): return hashlib.sha256(data).hexdigest()

def _b64(value, max_bytes, code):
    """Canonical standard base64 of at most max_bytes decoded bytes, else ValueError(code)."""
    if not isinstance(value, str) or not value.isascii() or not 0 < len(value) <= 4 * -(-max_bytes // 3): raise ValueError(code)
    try: raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError): raise ValueError(code) from None
    if base64.b64encode(raw).decode('ascii') != value or not 0 < len(raw) <= max_bytes: raise ValueError(code)
    return raw

def png_dimensions(data, *, max_side, max_pixels):
    """(width, height) from a structurally valid PNG: signature, IHDR first with a legal depth/color type, every chunk CRC-checked,
    at least one IDAT and IEND last with nothing after it. Header and chunk framing only; pixels are never decoded."""
    if not isinstance(data, bytes) or len(data) < 8 + 25 + 12 or not data.startswith(PNG_SIGNATURE): raise ValueError('png')
    pos, first, idat = 8, True, False
    while True:
        if pos + 12 > len(data): raise ValueError('png')
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        end = pos + 12 + length
        if not _CHUNK.fullmatch(kind) or end > len(data): raise ValueError('png')
        if zlib.crc32(data[pos + 4:pos + 8 + length]) != struct.unpack('>I', data[end - 4:end])[0]: raise ValueError('png')
        if first:
            if kind != b'IHDR' or length != 13: raise ValueError('png')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data[pos + 8:pos + 21])
            if not (1 <= width <= max_side and 1 <= height <= max_side and width * height <= max_pixels) \
                    or depth not in PNG_DEPTHS.get(color, ()) or compression or filtering or interlace not in (0, 1):
                raise ValueError('png')
            first = False
        elif kind == b'IHDR': raise ValueError('png')
        idat = idat or kind == b'IDAT'
        pos = end
        if kind == b'IEND':
            if length or pos != len(data) or not idat: raise ValueError('png')
            return width, height

def _source(data, keys, schema):
    if not isinstance(data, dict) or set(data) != keys or data['schema'] != schema: raise ValueError('invalid_request')
    sha = data['fileHash']
    if not isinstance(sha, str) or not _HEX.fullmatch(sha): raise ValueError('invalid_file_hash')
    source = _b64(data['file'], LIMITS['maxPdfBytes'], 'invalid_file')
    if not source.startswith(b'%PDF-'): raise ValueError('invalid_file')
    if _sha(source) != sha: raise ValueError('source_hash_mismatch')
    return source, sha

def validate_list_request(data):
    """(source_bytes, source_sha256) for an exact list request, else ValueError with a fixed code (never request text)."""
    return _source(data, LIST_REQUEST_KEYS, LIST_REQUEST_SCHEMA)

def validate_export_request(data):
    """(source, source_sha256, occurrence_id, replacement_png) for an exact export request, else ValueError with a fixed code."""
    source, sha = _source(data, EXPORT_REQUEST_KEYS, EXPORT_REQUEST_SCHEMA)
    if data['consent'] is not True: raise ValueError('consent_required')
    if not isinstance(data['occurrenceId'], str) or not _HEX.fullmatch(data['occurrenceId']): raise ValueError('invalid_occurrence_id')
    replacement = _b64(data['replacement'], LIMITS['maxPngBytes'], 'invalid_replacement')
    try: png_dimensions(replacement, max_side=LIMITS['maxPngSide'], max_pixels=LIMITS['maxPngPixels'])
    except (ValueError, struct.error): raise ValueError('invalid_replacement') from None
    return source, sha, data['occurrenceId'], replacement

# ---- strict validation of child output ----

def _int(v, lo, hi): return type(v) is int and lo <= v <= hi

def _bbox(value):
    """A copy of a finite, ordered, bounded [x0, y0, x1, y1] in page points, else None."""
    if not isinstance(value, list) or len(value) != 4: return None
    cap = LIMITS['maxCoordinate']
    if not all(type(v) in (int, float) and math.isfinite(v) and -cap <= v <= cap for v in value): return None
    x0, y0, x1, y1 = value
    return [x0, y0, x1, y1] if x0 < x1 and y0 < y1 else None

def _thumbnail(value):
    if value is None: return None
    side = LIMITS['maxThumbnailSide']
    raw = _b64(value, LIMITS['maxThumbnailBytes'], 'thumbnail')
    png_dimensions(raw, max_side=side, max_pixels=side * side)
    return value

def _occurrence(o):
    if not isinstance(o, dict) or set(o) != set(OCCURRENCE_KEYS): raise ValueError('occurrence')
    bbox = _bbox(o['bbox'])
    if not isinstance(o['id'], str) or not _HEX.fullmatch(o['id']) or not _int(o['pageIndex'], 0, LIMITS['maxPages'] - 1) \
            or bbox is None or not _int(o['width'], 1, LIMITS['maxImageSide']) or not _int(o['height'], 1, LIMITS['maxImageSide']) \
            or type(o['shared']) is not bool or type(o['editable']) is not bool: raise ValueError('occurrence')
    if (o['reason'] is not None) if o['editable'] else o['reason'] not in REASONS: raise ValueError('occurrence')
    return {'id': o['id'], 'pageIndex': o['pageIndex'], 'bbox': bbox, 'width': o['width'], 'height': o['height'],
        'shared': o['shared'], 'editable': o['editable'], 'reason': o['reason'], 'thumbnail': _thumbnail(o['thumbnail'])}

def public_list(value, source_sha256):
    """The exact list response rebuilt from validated fields, else ValueError."""
    if not isinstance(value, dict) or set(value) != {'schema', 'sourceSha256', 'complete', 'occurrences', 'limits'} \
            or value['schema'] != LIST_SCHEMA or value['sourceSha256'] != source_sha256 or type(value['complete']) is not bool \
            or value['limits'] != list(LIST_LIMITS) or not isinstance(value['occurrences'], list) \
            or len(value['occurrences']) > LIMITS['maxOccurrences']: raise ValueError('list')
    occurrences = [_occurrence(o) for o in value['occurrences']]
    if len({o['id'] for o in occurrences}) != len(occurrences): raise ValueError('list')
    result = {'schema': LIST_SCHEMA, 'sourceSha256': source_sha256, 'complete': value['complete'], 'occurrences': occurrences,
        'limits': list(LIST_LIMITS)}
    if len(json.dumps(result).encode('utf-8')) > LIMITS['maxListJsonBytes']: raise ValueError('list')
    return result

def public_report(value, source_sha256, occurrence_id, output_sha256):
    """The exact edit report bound to this source, occurrence and recomputed output hash, else ValueError."""
    if not isinstance(value, dict) or set(value) != set(REPORT_KEYS) or value['schema'] != REPORT_SCHEMA \
            or value['sourceSha256'] != source_sha256 or value['occurrenceId'] != occurrence_id \
            or value['outputSha256'] != output_sha256 or not _int(value['pageIndex'], 0, LIMITS['maxPages'] - 1) \
            or _bbox(value['bbox']) is None or type(value['changedOccurrences']) is not int or value['changedOccurrences'] != 1 \
            or value['check'] != 'passed' or value['limits'] != list(REPORT_LIMITS): raise ValueError('report')
    return {'schema': REPORT_SCHEMA, 'sourceSha256': source_sha256, 'occurrenceId': occurrence_id, 'outputSha256': output_sha256,
        'pageIndex': value['pageIndex'], 'bbox': _bbox(value['bbox']), 'changedOccurrences': 1, 'check': 'passed',
        'limits': list(REPORT_LIMITS)}

# ---- parent side: private child run ----

def _no_duplicates(items):
    out = {}
    for k, v in items:
        if k in out: raise ValueError('duplicate key')
        out[k] = v
    return out

def _no_constant(_name): raise ValueError('nonfinite JSON')

def _json(raw): return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_no_duplicates, parse_constant=_no_constant)

def default_runner(argv, *, input, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, input=input, cwd=cwd, env=env, timeout=timeout, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def _read_capped(path, cap):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > cap: raise ValueError('child file')
    raw = path.read_bytes()
    if len(raw) > cap: raise ValueError('child file')
    return raw

FAILED = lambda: ImageEditError(500, 'image_edit_failed')

def _run(op, source, source_sha256, runner, consume, occurrence_id=None, replacement=None):
    """Runs the child for op in a private directory and returns consume(workdir, envelope). Always removes the directory."""
    if not sys.executable: raise ImageEditError(503, 'image_editor_unavailable')
    workdir = None
    try:
        workdir = Path(tempfile.mkdtemp(prefix='falsify-image-'))
        with open(workdir / SOURCE_NAME, 'xb') as f: f.write(source)
        request = {'op': op, 'sourceSha256': source_sha256}
        if op == 'export':
            with open(workdir / REPLACEMENT_NAME, 'xb') as f: f.write(replacement)
            request.update(occurrenceId=occurrence_id, replacementSha256=_sha(replacement))
        stdin = json.dumps(request).encode('ascii')
        env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
        try:
            result = (runner or default_runner)([sys.executable, '-I', str(WORKER), '--worker'], input=stdin, cwd=str(workdir),
                env=env, timeout=LIMITS['timeoutSeconds'])
        except subprocess.TimeoutExpired: raise ImageEditError(504, 'image_edit_timeout') from None
        raw = result.stdout or b''
        if result.returncode != 0 or not isinstance(raw, bytes) or len(raw) > LIMITS['maxStdoutBytes']: raise FAILED()
        lines = [l for l in raw.decode('utf-8', 'strict').splitlines() if l.strip()]
        if len(lines) != 1: raise FAILED()
        envelope = _json(lines[0].encode('utf-8'))
        if not isinstance(envelope, dict) or envelope.get('schema') != ENVELOPE_SCHEMA or envelope.get('op') != op \
                or envelope.get('sourceSha256') != source_sha256: raise FAILED()
        if envelope.get('status') == 'error' and set(envelope) == {'schema', 'op', 'sourceSha256', 'status', 'reason'}:
            reason = envelope['reason']
            if reason == 'dependency-unavailable': raise ImageEditError(503, 'image_editor_unavailable')
            raise ImageEditError(422, 'image_edit_rejected', reason if isinstance(reason, str) and reason in EXPORT_REASONS
                else 'engine-error')
        if envelope.get('status') != 'ok': raise FAILED()
        return consume(workdir, envelope)
    except ImageEditError: raise
    except Exception: raise FAILED() from None   # OS, decode, JSON and shape failures: one fixed code, never their text
    finally:
        if workdir: shutil.rmtree(workdir, ignore_errors=True)

def list_images(request, *, runner=None):
    source, source_sha256 = request
    def consume(workdir, envelope):
        if set(envelope) != {'schema', 'op', 'sourceSha256', 'status'}: raise ValueError('envelope')
        return public_list(_json(_read_capped(workdir / LIST_NAME, LIMITS['maxListJsonBytes'])), source_sha256)
    return _run('list', source, source_sha256, runner, consume)

def export_image(request, *, runner=None):
    source, source_sha256, occurrence_id, replacement = request
    def consume(workdir, envelope):
        if set(envelope) != {'schema', 'op', 'sourceSha256', 'status', 'report'}: raise ValueError('envelope')
        output = _read_capped(workdir / OUTPUT_NAME, LIMITS['maxOutputBytes'])
        if not output.startswith(b'%PDF-') or output == source: raise ValueError('output')
        output_sha256 = _sha(output)   # recomputed here: the child's own hash is only compared, never trusted
        report = public_report(envelope['report'], source_sha256, occurrence_id, output_sha256)
        return {'schema': EXPORT_SCHEMA, 'sourceSha256': source_sha256, 'occurrenceId': occurrence_id, 'outputSha256': output_sha256,
            'filename': FILENAME, 'file': base64.b64encode(output).decode('ascii'), 'report': report}
    return _run('export', source, source_sha256, runner, consume, occurrence_id, replacement)

def capability():
    """Offered when this interpreter can start the child, the engine file is present and its dependencies are installed. Absence
    disables only image replacement; every other operation keeps working."""
    try: available = bool(sys.executable) and ENGINE.is_file() and all(importlib.util.find_spec(n) is not None for n in DEPENDENCIES)
    except (ImportError, ValueError, OSError): available = False
    return {'available': available, 'schema': LIST_SCHEMA}

# ---- child side (python -I image_edit_service.py --worker, cwd = the private directory) ----

def _load_engine():
    """The trusted engine by its fixed absolute path (-I: nothing from the working directory, PYTHONPATH or user site). The app
    directory is appended, never prepended, so the engine may import its sibling modules."""
    if str(HERE) not in sys.path: sys.path.append(str(HERE))
    spec = importlib.util.spec_from_file_location('image_occurrence_editor', ENGINE)
    module = importlib.util.module_from_spec(spec)
    sys.modules['image_occurrence_editor'] = module
    spec.loader.exec_module(module)
    return module

def _reason(error):
    if isinstance(error, ImportError): return 'dependency-unavailable'
    code = str(error) if isinstance(error, ValueError) else ''
    return code if code in EXPORT_REASONS else 'engine-error'

def _worker(out):
    request = json.loads(sys.stdin.buffer.read(LIMITS['maxStdinBytes'] + 1).decode('utf-8'))
    op, sha = request['op'], request['sourceSha256']
    base = {'schema': ENVELOPE_SCHEMA, 'op': op, 'sourceSha256': sha}
    work = Path.cwd()
    source = _read_capped(work / SOURCE_NAME, LIMITS['maxPdfBytes'])
    if op not in ('list', 'export') or _sha(source) != sha: raise ValueError('binding')
    if op == 'export':
        replacement = _read_capped(work / REPLACEMENT_NAME, LIMITS['maxPngBytes'])
        if _sha(replacement) != request['replacementSha256']: raise ValueError('binding')
    try:
        if not ENGINE.is_file(): raise ImportError('engine')
        engine = _load_engine()
        if op == 'list':
            (work / LIST_NAME).write_text(json.dumps(engine.list_occurrences(source)), encoding='utf-8')
            envelope = dict(base, status='ok')
        else:
            output, report = engine.replace_occurrence(source, request['occurrenceId'], replacement)
            with open(work / OUTPUT_NAME, 'xb') as f: f.write(output)
            envelope = dict(base, status='ok', report=report)
    except Exception as error:
        envelope = dict(base, status='error', reason=_reason(error))
    out.write(json.dumps(envelope) + '\n')

if __name__ == '__main__' and sys.argv[1:] == ['--worker']:
    # Only a private duplicate of fd 1 carries the envelope; fd 1 itself becomes devnull, so native library chatter (MuPDF prints
    # recoverable errors on stdout) can neither corrupt the envelope nor leak source-derived text.
    out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
    os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
    try: _worker(out)
    except Exception: out.write('{}\n')
    out.flush()
