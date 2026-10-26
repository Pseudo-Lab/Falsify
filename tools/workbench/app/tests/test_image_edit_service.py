"""Manual single-occurrence image replacement (POST /api/paper/images, /api/paper/images/export): strict request and response
contract, bytes-only admission, isolated child with rehash, temporary-directory cleanup, fixed errors and admission like export.
Synthetic bytes, ephemeral ports, fake runners and throwaway engines written to temporary directories only (no engine is committed
here); never invokes Codex, Claude or any model and never touches a server on 7816. Global ACTIVE/JOBS are restored after every test."""
import base64
import hashlib
import http.client
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch
LOCAL = Path(__file__).resolve().parents[1] / 'local'
sys.path.insert(0, str(LOCAL))
import server
import image_edit_service as svc

WEB = 'https://shinick-han.github.io'
SECRET = 'SECRET-source-sentence /tmp/private.pdf Traceback'
SOURCE = b'%PDF-1.7\n% synthetic bytes, not a readable document\n'
OUTPUT = b'%PDF-1.7\n% synthetic edited output\n'
OCC = 'a' * 64

def sha(data): return hashlib.sha256(data).hexdigest()
def b64(data): return base64.b64encode(data).decode('ascii')

def chunk(kind, body, crc=None):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) if crc is None else crc)

def png(width=2, height=2, depth=8, color=2, *, ihdr=None, extra=b'', tail=b''):
    header = ihdr if ihdr is not None else struct.pack('>IIBBBBB', width, height, depth, color, 0, 0, 0)
    return svc.PNG_SIGNATURE + chunk(b'IHDR', header) + extra + chunk(b'IDAT', zlib.compress(b'\0' * 8)) + chunk(b'IEND', b'') + tail

PNG = png()
THUMB = b64(png(320, 100))

def list_request(source=SOURCE, **over):
    data = {'schema': svc.LIST_REQUEST_SCHEMA, 'fileHash': sha(source), 'file': b64(source)}
    data.update(over); return data

def export_request(source=SOURCE, replacement=PNG, **over):
    data = {'schema': svc.EXPORT_REQUEST_SCHEMA, 'fileHash': sha(source), 'file': b64(source), 'occurrenceId': OCC,
        'replacement': b64(replacement), 'consent': True}
    data.update(over); return data

def occurrence(**over):
    o = {'id': OCC, 'pageIndex': 0, 'bbox': [72, 90.5, 300, 240], 'width': 640, 'height': 480, 'shared': False, 'editable': True,
        'reason': None, 'thumbnail': THUMB}
    o.update(over); return o

def good_list(source_sha256=None, occurrences=None, complete=True):
    return {'schema': svc.LIST_SCHEMA, 'sourceSha256': source_sha256 or sha(SOURCE), 'complete': complete,
        'occurrences': [occurrence()] if occurrences is None else occurrences, 'limits': list(svc.LIST_LIMITS)}

def good_report(output=OUTPUT, **over):
    r = {'schema': svc.REPORT_SCHEMA, 'sourceSha256': sha(SOURCE), 'occurrenceId': OCC, 'outputSha256': sha(output), 'pageIndex': 0,
        'bbox': [72, 90.5, 300, 240], 'changedOccurrences': 1, 'check': 'passed', 'limits': list(svc.REPORT_LIMITS)}
    r.update(over); return r

def envelope(op, status='ok', **extra):
    return {'schema': svc.ENVELOPE_SCHEMA, 'op': op, 'sourceSha256': sha(SOURCE), 'status': status, **extra}

class Runner:
    """Fake child: records the call and the private copies, writes fixed files into the private directory, answers fixed stdout."""
    def __init__(self, stdout=None, files=None, returncode=0, error=None, hook=None):
        self.stdout, self.files, self.returncode, self.error, self.hook, self.calls = stdout, files or {}, returncode, error, hook, []
    def __call__(self, argv, *, input, cwd, env, timeout):
        work = Path(cwd)
        self.calls.append({'argv': argv, 'input': input, 'cwd': cwd, 'env': env, 'timeout': timeout,
            'names': sorted(p.name for p in work.iterdir()), 'source': (work / svc.SOURCE_NAME).read_bytes(),
            'replacement': (work / svc.REPLACEMENT_NAME).read_bytes() if (work / svc.REPLACEMENT_NAME).exists() else None})
        for name, data in self.files.items(): (work / name).write_bytes(data)
        if self.hook: self.hook()
        if self.error: raise self.error
        out = self.stdout if isinstance(self.stdout, bytes) else (json.dumps(self.stdout) + '\n').encode()
        return subprocess.CompletedProcess(argv, self.returncode, out, None)

def list_runner(value=None, **kw):
    return Runner(envelope('list'), {svc.LIST_NAME: json.dumps(good_list() if value is None else value).encode()}, **kw)

def export_runner(output=OUTPUT, report=None, **kw):
    return Runner(envelope('export', report=good_report(output) if report is None else report), {svc.OUTPUT_NAME: output}, **kw)

class TempTracker:
    def __enter__(self):
        real, self.dirs = tempfile.mkdtemp, []
        def make(*a, **k):
            d = real(*a, **k); self.dirs.append(d); return d
        self.patch = patch.object(svc.tempfile, 'mkdtemp', make); self.patch.start(); return self
    def __exit__(self, *exc): self.patch.stop()
    def assertClean(self, case):
        case.assertTrue(self.dirs); case.assertFalse(any(Path(d).exists() for d in self.dirs))

def leaves(value):
    if isinstance(value, dict): return [x for k, v in value.items() for x in [k, *leaves(v)]]
    if isinstance(value, list): return [x for v in value for x in leaves(v)]
    return [value]

class RequestValidationTests(unittest.TestCase):
    def assertCode(self, fn, data, code):
        with self.assertRaises(ValueError) as caught: fn(data)
        self.assertEqual(str(caught.exception), code)
        self.assertNotIn('SECRET', str(caught.exception))
    def test_exact_requests_accepted(self):
        self.assertEqual(svc.validate_list_request(list_request()), (SOURCE, sha(SOURCE)))
        self.assertEqual(svc.validate_export_request(export_request()), (SOURCE, sha(SOURCE), OCC, PNG))
        for color, depth in [(0, 1), (0, 16), (3, 4), (4, 8), (6, 16)]:
            self.assertEqual(svc.validate_export_request(export_request(replacement=png(color=color, depth=depth)))[3][:8], svc.PNG_SIGNATURE)
        self.assertEqual(svc.png_dimensions(png(8192, 488), max_side=8192, max_pixels=4_000_000), (8192, 488))
    def test_request_shape(self):
        for fn, make in [(svc.validate_list_request, list_request), (svc.validate_export_request, export_request)]:
            good = make()
            for bad in [None, [], 'x', {k: v for k, v in good.items() if k != 'file'}, dict(good, extra=1), dict(good, schema='v2'),
                    dict(good, schema=svc.LIST_REQUEST_SCHEMA if fn is svc.validate_export_request else svc.EXPORT_REQUEST_SCHEMA)]:
                with self.subTest(fn=fn.__name__, bad=str(bad)[:40]): self.assertCode(fn, bad, 'invalid_request')
    def test_source_bytes_and_hash(self):
        fn = svc.validate_list_request
        for bad in [1, None, 'A' * 64, 'a' * 63, 'g' * 64]: self.assertCode(fn, list_request(fileHash=bad), 'invalid_file_hash')
        for bad in ['', 1, b64(SOURCE) + '=', b64(SOURCE)[:-1], '-' + b64(SOURCE)[1:], ' ' + b64(SOURCE), 'é' + b64(SOURCE),
                b64(SOURCE) + '\n']:
            self.assertCode(fn, list_request(file=bad), 'invalid_file')
        padded = b'%PDF-1.7\n\n'
        self.assertTrue(b64(padded).endswith('Cg=='))
        noncanonical = b64(padded)[:-3] + 'h=='   # nonzero padding bits: same bytes, not the canonical encoding
        self.assertEqual(base64.b64decode(noncanonical), padded)
        self.assertCode(fn, list_request(padded, file=noncanonical), 'invalid_file')
        self.assertCode(fn, list_request(padded, file=b64(padded).rstrip('=')), 'invalid_file')
        self.assertCode(fn, list_request(b'not a pdf'), 'invalid_file')
        self.assertCode(fn, list_request(fileHash=sha(b'other')), 'source_hash_mismatch')
        with patch.dict(svc.LIMITS, maxPdfBytes=len(SOURCE) - 1): self.assertCode(fn, list_request(), 'invalid_file')
    def test_export_fields(self):
        fn = svc.validate_export_request
        for bad in [False, None, 1, 'true']: self.assertCode(fn, export_request(consent=bad), 'consent_required')
        for bad in [None, 1, 'A' * 64, 'a' * 65, SECRET]: self.assertCode(fn, export_request(occurrenceId=bad), 'invalid_occurrence_id')
        self.assertCode(fn, export_request(fileHash=sha(b'x')), 'source_hash_mismatch')
        with patch.dict(svc.LIMITS, maxPngBytes=len(PNG) - 1): self.assertCode(fn, export_request(), 'invalid_replacement')
    def test_png_header_checked_before_decode(self):
        good_ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
        idat, iend = chunk(b'IDAT', zlib.compress(b'\0' * 8)), chunk(b'IEND', b'')
        cases = {
            'jpeg': b'\xff\xd8\xff\xe0' + b'\0' * 60, 'svg': b'<svg xmlns="http://www.w3.org/2000/svg"/>' + b' ' * 30,
            'bad signature': b'\x89PNG\r\n\x1a\x0b' + PNG[8:], 'too short': PNG[:40],
            'ihdr not first': svc.PNG_SIGNATURE + idat + chunk(b'IHDR', good_ihdr) + iend,
            'ihdr length': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr + b'\0') + idat + iend,
            'ihdr crc': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr, crc=0) + idat + iend,
            'idat crc': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr) + chunk(b'IDAT', b'x', crc=1) + iend,
            'zero width': png(0, 2), 'zero height': png(2, 0), 'width over 8192': png(8193, 1), 'height over 8192': png(1, 8193),
            'pixels over 4M': png(2001, 2000), 'huge declared': png(0xFFFFFFFF, 0xFFFFFFFF),
            'bad depth': png(depth=4, color=2), 'bad color': png(color=5), 'compression': png(ihdr=good_ihdr[:10] + b'\x01\0\0'),
            'interlace 2': png(ihdr=good_ihdr[:12] + b'\x02'), 'second ihdr': png(extra=chunk(b'IHDR', good_ihdr)),
            'no idat': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr) + iend, 'no iend': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr) + idat,
            'trailing bytes': png(tail=b'\0'), 'iend body': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr) + idat + chunk(b'IEND', b'x'),
            'chunk overrun': svc.PNG_SIGNATURE + chunk(b'IHDR', good_ihdr) + struct.pack('>I', 1 << 30) + b'IDAT' + b'\0' * 8,
            'bad chunk type': png(extra=chunk(b'te t', b'')),
        }
        for name, data in cases.items():
            with self.subTest(case=name):
                self.assertCode(svc.validate_export_request, export_request(replacement=data), 'invalid_replacement')
        with patch.object(svc.zlib, 'decompress', side_effect=AssertionError('decoded')):
            self.assertEqual(svc.validate_export_request(export_request())[3], PNG)
    def test_parent_never_imports_native_dependencies(self):
        code = ('import sys; sys.path.insert(0, %r); import image_edit_service as s; '
            'print(sorted(n for n in ("pymupdf", "fitz", "pikepdf", "PIL", "image_occurrence_editor") if n in sys.modules))') % str(LOCAL)
        out = subprocess.run([sys.executable, '-I', '-c', code], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), '[]')

class ChildContractTests(unittest.TestCase):
    def assertError(self, fn, request, runner, status, code, reason=None):
        with TempTracker() as t, patch.object(svc, 'default_runner', runner):
            with self.assertRaises(svc.ImageEditError) as caught: fn(request)
        t.assertClean(self)
        self.assertEqual((caught.exception.status, caught.exception.payload()),
            (status, {'error': code, 'reason': reason} if reason else {'error': code}))
        self.assertNotIn('SECRET', json.dumps(caught.exception.payload()) + str(caught.exception))
        return runner
    def test_list_rebuilt_exactly(self):
        noisy = good_list(occurrences=[occurrence(), occurrence(id='b' * 64, pageIndex=63, shared=True, editable=False,
            reason='clipped-image', thumbnail=None, bbox=[0, 0, 1e-3, 0.5])])
        runner = list_runner(noisy)
        with TempTracker() as t, patch.object(svc, 'default_runner', runner): result = svc.list_images((SOURCE, sha(SOURCE)))
        t.assertClean(self)
        self.assertEqual(result, noisy); self.assertEqual(list(result), ['schema', 'sourceSha256', 'complete', 'occurrences', 'limits'])
        self.assertEqual([list(o) for o in result['occurrences']], [list(svc.OCCURRENCE_KEYS)] * 2)
        call = runner.calls[0]
        self.assertEqual(call['argv'], [sys.executable, '-I', str(svc.WORKER), '--worker'])
        self.assertEqual(call['names'], [svc.SOURCE_NAME]); self.assertEqual(call['source'], SOURCE)
        self.assertEqual(json.loads(call['input']), {'op': 'list', 'sourceSha256': sha(SOURCE)})
        self.assertEqual(call['timeout'], 90); self.assertTrue(set(call['env']) <= set(svc.ENV_ALLOW))
        self.assertTrue(Path(call['cwd']).name.startswith('falsify-image-'))
        empty = good_list(occurrences=[], complete=False)
        with patch.object(svc, 'default_runner', list_runner(empty)): self.assertEqual(svc.list_images((SOURCE, sha(SOURCE))), empty)
    def test_tampered_lists_fail_closed(self):
        o = occurrence
        cases = {
            'extra top key': dict(good_list(), note=SECRET), 'wrong hash': good_list('b' * 64), 'wrong schema': dict(good_list(), schema='v2'),
            'complete not bool': dict(good_list(), complete=1), 'limits': dict(good_list(), limits=['single-occurrence']),
            'too many': good_list(occurrences=[o(id='%064x' % i) for i in range(257)]),
            'duplicate id': good_list(occurrences=[o(), o()]), 'extra occurrence key': good_list(occurrences=[dict(o(), text=SECRET)]),
            'missing key': good_list(occurrences=[{k: v for k, v in o().items() if k != 'thumbnail'}]),
            'id xref': good_list(occurrences=[o(id='12')]), 'page 64': good_list(occurrences=[o(pageIndex=64)]),
            'page bool': good_list(occurrences=[o(pageIndex=False)]), 'bbox order': good_list(occurrences=[o(bbox=[10, 0, 5, 9])]),
            'bbox len': good_list(occurrences=[o(bbox=[0, 0, 1])]), 'bbox str': good_list(occurrences=[o(bbox=[0, 0, 1, SECRET])]),
            'bbox huge': good_list(occurrences=[o(bbox=[0, 0, 1e9, 1])]), 'width 0': good_list(occurrences=[o(width=0)]),
            'height float': good_list(occurrences=[o(height=2.0)]), 'shared int': good_list(occurrences=[o(shared=1)]),
            'editable with reason': good_list(occurrences=[o(reason='transparency')]),
            'not editable no reason': good_list(occurrences=[o(editable=False)]),
            'free reason': good_list(occurrences=[o(editable=False, reason=SECRET)]),
            'thumb jpeg': good_list(occurrences=[o(thumbnail=b64(b'\xff\xd8\xff' + b'\0' * 64))]),
            'thumb 321': good_list(occurrences=[o(thumbnail=b64(png(321, 1)))]),
            'thumb noncanonical': good_list(occurrences=[o(thumbnail=THUMB + '\n')]),
        }
        for name, value in cases.items():
            with self.subTest(case=name): self.assertError(svc.list_images, (SOURCE, sha(SOURCE)), list_runner(value), 500, 'image_edit_failed')
        with self.subTest(case='nan'):
            runner = Runner(envelope('list'), {svc.LIST_NAME: json.dumps(good_list()).replace('72', 'NaN').encode()})
            self.assertError(svc.list_images, (SOURCE, sha(SOURCE)), runner, 500, 'image_edit_failed')
        with self.subTest(case='thumbnail over 256 KiB'), patch.dict(svc.LIMITS, maxThumbnailBytes=len(base64.b64decode(THUMB)) - 1):
            self.assertError(svc.list_images, (SOURCE, sha(SOURCE)), list_runner(), 500, 'image_edit_failed')
        with self.subTest(case='list json over cap'), patch.dict(svc.LIMITS, maxListJsonBytes=100):
            self.assertError(svc.list_images, (SOURCE, sha(SOURCE)), list_runner(), 500, 'image_edit_failed')
    def test_transport_failures_fail_closed_and_clean_up(self):
        req = (SOURCE, sha(SOURCE)); env = envelope('list'); files = {svc.LIST_NAME: json.dumps(good_list()).encode()}
        cases = {'nonzero': Runner(env, files, returncode=1), 'empty': Runner(b''), 'chatter': Runner(b'MuPDF error: x\n' + json.dumps(env).encode()),
            'not utf8': Runner(b'\xff\n'), 'wrong op': Runner(envelope('export'), files), 'wrong hash': Runner(dict(env, sourceSha256='b' * 64), files),
            'extra envelope key': Runner(dict(env, detail=SECRET), files), 'no list file': Runner(env), 'os error': Runner(env, error=OSError(SECRET)),
            'huge stdout': Runner(b'{' * (64 * 1024 + 1)), 'status other': Runner(dict(env, status='partial'), files),
            'error extra key': Runner(dict(env, status='error', reason='scan-limit', message=SECRET))}
        for name, runner in cases.items():
            with self.subTest(case=name): self.assertError(svc.list_images, req, runner, 500, 'image_edit_failed')
        self.assertError(svc.list_images, req, Runner(error=subprocess.TimeoutExpired('x', 90)), 504, 'image_edit_timeout')
    def test_engine_reasons_are_fixed_codes(self):
        req = (SOURCE, sha(SOURCE), OCC, PNG)
        for reason in ['clipped-image', 'occurrence-not-found', 'check-failed', 'replacement-transparent']:
            self.assertError(svc.export_image, req, Runner(envelope('export', 'error', reason=reason)), 422, 'image_edit_rejected', reason)
        for reason in [SECRET, None, 7, '']:
            self.assertError(svc.export_image, req, Runner(envelope('export', 'error', reason=reason)), 422, 'image_edit_rejected', 'engine-error')
        self.assertError(svc.export_image, req, Runner(envelope('export', 'error', reason='dependency-unavailable')), 503, 'image_editor_unavailable')
        self.assertError(svc.list_images, req[:2], Runner(envelope('list', 'error', reason='dependency-unavailable')), 503, 'image_editor_unavailable')
    def test_no_op_refusal_kept_and_raw_reasons_sanitized(self):
        req = (SOURCE, sha(SOURCE), OCC, PNG)
        self.assertError(svc.export_image, req, Runner(envelope('export', 'error', reason='no-op')), 422, 'image_edit_rejected', 'no-op')
        self.assertEqual(svc._reason(ValueError('no-op')), 'no-op')
        for reason in ['no-op: ' + SECRET, 'No-Op', 'noop', 'output-limit', 'rawpaper']:
            with self.subTest(reason=reason):
                self.assertError(svc.export_image, req, Runner(envelope('export', 'error', reason=reason)), 422, 'image_edit_rejected', 'engine-error')
                self.assertEqual(svc._reason(ValueError(reason)), 'engine-error')
        self.assertEqual(svc._reason(RuntimeError('no-op')), 'engine-error')
    def test_export_recomputes_hashes(self):
        runner = export_runner()
        with TempTracker() as t, patch.object(svc, 'default_runner', runner): result = svc.export_image((SOURCE, sha(SOURCE), OCC, PNG))
        t.assertClean(self)
        self.assertEqual(result, {'schema': svc.EXPORT_SCHEMA, 'sourceSha256': sha(SOURCE), 'occurrenceId': OCC, 'outputSha256': sha(OUTPUT),
            'filename': 'falsify-image-experiment.pdf', 'file': b64(OUTPUT), 'report': good_report()})
        call = runner.calls[0]
        self.assertEqual(call['names'], [svc.REPLACEMENT_NAME, svc.SOURCE_NAME]); self.assertEqual(call['replacement'], PNG)
        self.assertEqual(json.loads(call['input']), {'op': 'export', 'sourceSha256': sha(SOURCE), 'occurrenceId': OCC, 'replacementSha256': sha(PNG)})
    def test_tampered_exports_fail_closed(self):
        req = (SOURCE, sha(SOURCE), OCC, PNG)
        cases = {'worker output hash': export_runner(report=good_report(outputSha256='c' * 64)),
            'stale output hash': export_runner(b'%PDF-1.7 other', report=good_report(OUTPUT)),
            'other occurrence': export_runner(report=good_report(occurrenceId='b' * 64)),
            'other source': export_runner(report=good_report(sourceSha256='b' * 64)), 'two changed': export_runner(report=good_report(changedOccurrences=2)),
            'changed true': export_runner(report=good_report(changedOccurrences=True)), 'check': export_runner(report=good_report(check='failed')),
            'limits': export_runner(report=good_report(limits=['engine-render-check'])), 'extra key': export_runner(report=dict(good_report(), log=SECRET)),
            'bbox': export_runner(report=good_report(bbox=[1, 1, 0, 0])), 'page': export_runner(report=good_report(pageIndex=-1)),
            'unchanged output': export_runner(SOURCE, report=good_report(SOURCE)), 'not pdf': export_runner(b'PK\x03\x04', report=good_report(b'PK\x03\x04')),
            'no output file': Runner(envelope('export', report=good_report())), 'no report': Runner(envelope('export'), {svc.OUTPUT_NAME: OUTPUT})}
        for name, runner in cases.items():
            with self.subTest(case=name): self.assertError(svc.export_image, req, runner, 500, 'image_edit_failed')
        with patch.dict(svc.LIMITS, maxOutputBytes=len(OUTPUT) - 1):
            self.assertError(svc.export_image, req, export_runner(), 500, 'image_edit_failed')
    def test_capability_descriptor(self):
        cap = svc.capability()
        self.assertEqual(set(cap), {'available', 'schema'}); self.assertEqual(cap['schema'], 'falsify.image-list.v1')
        self.assertIs(cap['available'], svc.ENGINE.is_file() and all(svc.importlib.util.find_spec(n) for n in svc.DEPENDENCIES))
        with patch.object(svc, 'ENGINE', Path(tempfile.gettempdir()) / 'falsify-missing-engine.py'):
            self.assertEqual(svc.capability(), {'available': False, 'schema': svc.LIST_SCHEMA})
        with patch.object(svc.importlib.util, 'find_spec', lambda name: None), patch.object(svc, 'ENGINE', Path(__file__)):
            self.assertEqual(svc.capability(), {'available': False, 'schema': svc.LIST_SCHEMA})

ENGINE_TEMPLATE = '''
import hashlib, json, os, sys, time
MODE = %r
def _thumb():
    return %r
def list_occurrences(source):
    print('MuPDF error: chatter with SECRET source text')   # native stdout noise must never reach the envelope
    os.write(1, b'raw fd chatter\\n')
    if MODE == 'sleep': time.sleep(30)
    if MODE == 'raise': raise RuntimeError('SECRET /private/path Traceback')
    if MODE == 'import': raise ImportError('pikepdf')
    if MODE == 'cwd':
        try: import shadow_probe
        except ImportError: raise ValueError('scan-limit')   # the working directory's shadow module was not importable
    h = hashlib.sha256(source).hexdigest()
    return {'schema': 'falsify.image-list.v1', 'sourceSha256': h, 'complete': True, 'limits': ['single-occurrence', 'manual-image', 'text-only-blue'],
        'occurrences': [{'id': hashlib.sha256((h + ':p0:Do0').encode()).hexdigest(), 'pageIndex': 0, 'bbox': (10.0, 20.0, 110.0, 70.0),
            'width': 4, 'height': 2, 'shared': False, 'editable': True, 'reason': None, 'thumbnail': _thumb()}]}
def replace_occurrence(source, occurrence_id, replacement_png):
    print('chatter')
    if MODE == 'unsupported': raise ValueError('overlapping-content')
    out = source + b'%% edited ' + hashlib.sha256(replacement_png).hexdigest().encode() + b'\\n'
    return out, {'schema': 'falsify.image-edit-report.v1', 'sourceSha256': hashlib.sha256(source).hexdigest(), 'occurrenceId': occurrence_id,
        'outputSha256': hashlib.sha256(out).hexdigest(), 'pageIndex': 0, 'bbox': [10.0, 20.0, 110.0, 70.0], 'changedOccurrences': 1,
        'check': 'passed', 'limits': ['engine-render-check', 'domain-review-pending', 'text-only-blue']}
'''

class RealChildTests(unittest.TestCase):
    """The real worker entry point, copied with a throwaway engine into a temporary app directory (never committed)."""
    def app(self, mode):
        root = Path(tempfile.mkdtemp(prefix='falsify-image-app-')); self.addCleanup(shutil.rmtree, root, True)
        shutil.copy(LOCAL / 'image_edit_service.py', root / 'image_edit_service.py')
        (root / 'image_occurrence_editor.py').write_text(ENGINE_TEMPLATE % (mode, THUMB), encoding='utf-8')
        for name, value in [('WORKER', root / 'image_edit_service.py'), ('ENGINE', root / 'image_occurrence_editor.py')]:
            p = patch.object(svc, name, value); p.start(); self.addCleanup(p.stop)
        return root
    def test_list_and_export_through_child(self):
        self.app('ok')
        with TempTracker() as t: listed = svc.list_images((SOURCE, sha(SOURCE)))
        t.assertClean(self)
        self.assertEqual(listed['sourceSha256'], sha(SOURCE)); self.assertEqual(listed['occurrences'][0]['bbox'], [10.0, 20.0, 110.0, 70.0])
        self.assertNotIn('SECRET', json.dumps(listed))
        occ = listed['occurrences'][0]['id']
        with TempTracker() as t: result = svc.export_image((SOURCE, sha(SOURCE), occ, PNG))
        t.assertClean(self)
        output = base64.b64decode(result['file'])
        self.assertEqual(result['outputSha256'], sha(output)); self.assertTrue(output.startswith(SOURCE))
        self.assertEqual(result['report']['occurrenceId'], occ)
    def test_engine_failures_never_leak(self):
        for mode, fn, status, payload in [('raise', 'list', 422, {'error': 'image_edit_rejected', 'reason': 'engine-error'}),
                ('import', 'list', 503, {'error': 'image_editor_unavailable'}),
                ('unsupported', 'export', 422, {'error': 'image_edit_rejected', 'reason': 'overlapping-content'})]:
            with self.subTest(mode=mode):
                self.app(mode)
                with TempTracker() as t, self.assertRaises(svc.ImageEditError) as caught:
                    svc.list_images((SOURCE, sha(SOURCE))) if fn == 'list' else svc.export_image((SOURCE, sha(SOURCE), OCC, PNG))
                t.assertClean(self); self.assertEqual((caught.exception.status, caught.exception.payload()), (status, payload))
    def test_missing_engine_is_dependency_unavailable(self):
        root = self.app('ok'); (root / 'image_occurrence_editor.py').unlink()
        with self.assertRaises(svc.ImageEditError) as caught: svc.list_images((SOURCE, sha(SOURCE)))
        self.assertEqual(caught.exception.payload(), {'error': 'image_editor_unavailable'})
    def test_child_ignores_shadow_modules_in_working_directory(self):
        self.app('cwd')
        real = tempfile.mkdtemp
        def make(*a, **k):
            d = real(*a, **k); (Path(d) / 'shadow_probe.py').write_text('raise SystemExit(0)\n'); (Path(d) / 'json.py').write_text('x = 1\n'); return d
        with patch.object(svc.tempfile, 'mkdtemp', make), self.assertRaises(svc.ImageEditError) as caught: svc.list_images((SOURCE, sha(SOURCE)))
        self.assertEqual(caught.exception.payload(), {'error': 'image_edit_rejected', 'reason': 'scan-limit'})
    def test_child_rehashes_private_copy(self):
        self.app('ok')
        def tamper(argv, **kw):
            (Path(kw['cwd']) / svc.SOURCE_NAME).write_bytes(SOURCE + b'x'); return svc.default_runner(argv, **kw)
        with self.assertRaises(svc.ImageEditError) as caught: svc.list_images((SOURCE, sha(SOURCE)), runner=tamper)
        self.assertEqual(caught.exception.payload(), {'error': 'image_edit_failed'})
    def test_real_timeout_cleans_up(self):
        self.app('sleep')
        with patch.dict(svc.LIMITS, timeoutSeconds=2), TempTracker() as t, self.assertRaises(svc.ImageEditError) as caught:
            started = time.monotonic(); svc.list_images((SOURCE, sha(SOURCE)))
        self.assertLess(time.monotonic() - started, 20); t.assertClean(self)
        self.assertEqual((caught.exception.status, caught.exception.payload()), (504, {'error': 'image_edit_timeout'}))

def active_free():
    if not server.ACTIVE.acquire(blocking=False): return False
    server.ACTIVE.release(); return True

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(active_free(), 'ACTIVE leaked from an earlier test')
        jobs = patch.dict(server.JOBS, clear=True); jobs.start(); self.addCleanup(jobs.stop)
        def no_model(*a, **k): raise AssertionError('image operations must never start a RED/BLUE model review')
        for name in ('run_review', 'run_blue_review'):
            p = patch.object(server, name, no_model); p.start(); self.addCleanup(p.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler); self.http.daemon_threads = True
        self.http.web_origin = WEB; self.port = self.http.server_port
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(self.stop)
    def stop(self):
        if self.thread.is_alive(): self.http.shutdown()
        self.thread.join(5); self.http.server_close()
        self.assertTrue(active_free(), 'ACTIVE still held after server_close')
    def call(self, path='/api/paper/images', method='POST', body=None, origin=WEB, token=True, headers=None, host=None,
            content_type='application/json'):
        h = {'Host': host or f'127.0.0.1:{self.port}'}
        if origin is not None: h['Origin'] = origin
        if token is True: h['Authorization'] = 'Bearer ' + server.TOKEN
        elif token: h['Authorization'] = token
        if body is not None and content_type: h['Content-Type'] = content_type
        h.update(headers or {})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            conn.request(method, path, body=json.dumps(body).encode() if isinstance(body, (dict, list)) else body, headers=h)
            res = conn.getresponse(); raw = res.read()
        finally: conn.close()
        data = json.loads(raw) if res.getheader('Content-Type', '').startswith('application/json') else raw
        return res.status, {k.lower(): v for k, v in res.getheaders()}, data
    def fake(self, runner):
        p = patch.object(svc, 'default_runner', runner); p.start(); self.addCleanup(p.stop); return runner
    def test_preflight_allowlist(self):
        for path in svc_routes():
            status, h, _ = self.call(path, 'OPTIONS', token=False, headers={'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization, content-type'})
            self.assertEqual(status, 204); self.assertEqual(h['access-control-allow-origin'], WEB)
        for method, hdrs, origin, path in [('GET', 'authorization', WEB, '/api/paper/images'), ('PUT', 'authorization', WEB, '/api/paper/images'),
                ('POST', 'authorization, x-falsify-launcher', WEB, '/api/paper/images/export'),
                ('POST', 'authorization', 'https://attacker.example', '/api/paper/images'), ('POST', 'authorization', 'null', '/api/paper/images/export'),
                ('POST', 'authorization', WEB, '/api/paper/images/'), ('POST', 'authorization', WEB, '/api/paper/images/export/'),
                ('POST', 'authorization', WEB, '/api/paper/images/replace'), ('POST', 'authorization', WEB, '/api/paper/image')]:
            with self.subTest(method=method, origin=origin, path=path):
                status, h, _ = self.call(path, 'OPTIONS', origin=origin, token=False, headers={'Access-Control-Request-Method': method,
                    'Access-Control-Request-Headers': hdrs})
                self.assertEqual(status, 403); self.assertNotIn('access-control-allow-origin', h)
    def test_unauthorized_foreign_and_unknown_paths_never_run(self):
        runner = self.fake(list_runner())
        for path, body in [('/api/paper/images', list_request()), ('/api/paper/images/export', export_request())]:
            for name, kw in [('no token', {'token': False}), ('wrong token', {'token': 'Bearer wrong'}), ('bare token', {'token': server.TOKEN}),
                    ('foreign origin', {'origin': 'https://attacker.example'}), ('null origin', {'origin': 'null'}), ('no origin', {'origin': None}),
                    ('localhost host', {'host': f'localhost:{self.port}'}), ('launcher style', {'origin': None, 'headers': {'X-Falsify-Launcher': '1'}})]:
                with self.subTest(path=path, case=name):
                    status, h, _ = self.call(path, body=body, **kw)
                    self.assertEqual(status, 403)
                    if 'origin' in kw or 'host' in kw: self.assertNotIn('access-control-allow-origin', h)
        for path in ['/api/paper/images/', '/api/paper/images/list', '/api/paper/images/export/x', '/api/paper/IMAGES']:
            with self.subTest(path=path):
                self.assertEqual(self.call(path, body=list_request(), origin=f'http://127.0.0.1:{self.port}')[0], 404)
                self.assertEqual(self.call(path, body=list_request())[0], 403)   # not a CORS route for the web origin
        status, _, _ = self.call('/api/paper/images', 'GET', origin=f'http://127.0.0.1:{self.port}')
        self.assertEqual(status, 404); self.assertEqual(runner.calls, []); self.assertTrue(active_free())
    def test_same_origin_browser_lists(self):
        runner = self.fake(list_runner())
        status, h, data = self.call(origin=f'http://127.0.0.1:{self.port}', body=list_request())
        self.assertEqual((status, data), (200, good_list())); self.assertNotIn('access-control-allow-origin', h)
        self.assertEqual(len(runner.calls), 1); self.assertTrue(active_free())
    def test_web_origin_list_and_export_keep_jobs(self):
        retained = {'id': 'kept', 'role': 'red', 'state': 'completed', 'finished': time.monotonic()}
        server.JOBS['kept'] = retained
        self.fake(list_runner())
        status, h, data = self.call(body=list_request())
        self.assertEqual((status, data), (200, good_list())); self.assertEqual(h['access-control-allow-origin'], WEB)
        self.fake(export_runner())
        status, h, data = self.call('/api/paper/images/export', body=export_request())
        self.assertEqual(status, 200); self.assertEqual(h['access-control-allow-origin'], WEB)
        self.assertEqual((data['outputSha256'], base64.b64decode(data['file'])), (sha(OUTPUT), OUTPUT))
        self.assertEqual(server.JOBS, {'kept': retained}); self.assertTrue(active_free())
    def test_invalid_requests_refused_before_admission(self):
        runner = self.fake(export_runner())
        cases = [('/api/paper/images', dict(list_request(), fileHash=sha(b'x')), 'source_hash_mismatch'),
            ('/api/paper/images', export_request(), 'invalid_request'), ('/api/paper/images/export', list_request(), 'invalid_request'),
            ('/api/paper/images/export', export_request(consent=False), 'consent_required'),
            ('/api/paper/images/export', export_request(replacement=png(9000, 1)), 'invalid_replacement'),
            ('/api/paper/images/export', export_request(occurrenceId=SECRET), 'invalid_occurrence_id')]
        self.assertTrue(server.ACTIVE.acquire(blocking=False))   # validation must answer even while another operation runs
        try:
            for path, body, code in cases:
                with self.subTest(code=code, path=path):
                    status, h, data = self.call(path, body=body)
                    self.assertEqual((status, data), (400, {'error': code})); self.assertEqual(h['access-control-allow-origin'], WEB)
        finally: server.ACTIVE.release()
        self.assertEqual(self.call(body=list_request(), content_type='text/plain')[0], 400)
        self.assertEqual(self.call(body=b'{"schema":1,"schema":2}')[0], 400)
        self.assertEqual(runner.calls, []); self.assertTrue(active_free())
    def test_body_limits(self):
        for path, limit in [('/api/paper/images', 37 * 1024 * 1024), ('/api/paper/images/export', 40 * 1024 * 1024)]:
            with self.subTest(path=path):
                conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
                try:
                    conn.putrequest('POST', path, skip_host=True, skip_accept_encoding=True)
                    for k, v in [('Host', f'127.0.0.1:{self.port}'), ('Origin', WEB), ('Authorization', 'Bearer ' + server.TOKEN),
                            ('Content-Type', 'application/json'), ('Content-Length', str(limit + 1))]: conn.putheader(k, v)
                    conn.endheaders(); res = conn.getresponse(); res.read()
                finally: conn.close()
                self.assertEqual(res.status, 400)
        self.assertGreater(40 * 1024 * 1024, len(json.dumps(export_request(b'%PDF-' + b'x' * (25 * 1024 * 1024 - 5), b'x' * 4 * 1024 * 1024))))
    def test_busy_closing_and_restart_reserved_refuse(self):
        runner = self.fake(list_runner())
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        try:
            for path, body in [('/api/paper/images', list_request()), ('/api/paper/images/export', export_request())]:
                status, h, data = self.call(path, body=body)
                self.assertEqual((status, data), (409, {'error': 'companion_busy'})); self.assertEqual(h['access-control-allow-origin'], WEB)
        finally: server.ACTIVE.release()
        self.http.closing = True
        try: self.assertEqual(self.call(body=list_request())[::2], (409, {'error': 'companion_busy'}))
        finally: self.http.closing = False
        self.assertEqual(runner.calls, []); self.assertTrue(active_free())
    def test_active_blocks_red_blue_export_and_restart(self):
        started, release = threading.Event(), threading.Event()
        def hold(): started.set(); release.wait(10)
        self.fake(export_runner(hook=hold))
        result = {}
        worker = threading.Thread(target=lambda: result.setdefault('response', self.call('/api/paper/images/export', body=export_request())))
        worker.start()
        try:
            self.assertTrue(started.wait(10))
            self.assertEqual(self.call(body=list_request())[::2], (409, {'error': 'companion_busy'}))
            status, _, _ = self.call('/api/export', body={'x': 1}); self.assertEqual(status, 409)
            red = {'requestId': 'r1', 'revision': 'rev-busy', 'sourceHash': 'ab' * 32}
            with patch.object(server, 'validate_request', lambda d: None):
                self.assertEqual(self.call('/api/red/jobs', body=red)[0], 409)
            self.assertEqual(server.JOBS, {})
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
            try:
                body = json.dumps({'schema': server.LIFECYCLE_SCHEMA, 'instanceId': self.http.instance_id}).encode()
                conn.request('POST', '/api/launcher/restart', body=body, headers={'Host': f'127.0.0.1:{self.port}', 'X-Falsify-Launcher': '1',
                    'Authorization': 'Bearer ' + server.TOKEN, 'Content-Type': 'application/json'})
                res = conn.getresponse(); restart = (res.status, json.loads(res.read()))
            finally: conn.close()
            self.assertEqual(restart, (409, {'error': 'companion_busy'})); self.assertFalse(self.http.closing)
        finally:
            release.set(); worker.join(20)
        self.assertEqual(result['response'][0], 200); self.assertTrue(active_free())
    def test_failures_release_active_with_fixed_errors(self):
        cases = [(Runner(error=OSError(SECRET)), 500, {'error': 'image_edit_failed'}),
            (Runner(error=subprocess.TimeoutExpired('x', 90)), 504, {'error': 'image_edit_timeout'}),
            (Runner(envelope('export', 'error', reason='dependency-unavailable')), 503, {'error': 'image_editor_unavailable'}),
            (Runner(envelope('export', 'error', reason='transparency')), 422, {'error': 'image_edit_rejected', 'reason': 'transparency'}),
            (export_runner(report=good_report(outputSha256='c' * 64)), 500, {'error': 'image_edit_failed'})]
        for runner, status, payload in cases:
            with self.subTest(payload=payload), TempTracker() as t:
                self.fake(runner)
                got_status, h, data = self.call('/api/paper/images/export', body=export_request())
                self.assertEqual((got_status, data), (status, payload)); self.assertEqual(h['access-control-allow-origin'], WEB)
                self.assertNotIn('SECRET', json.dumps(data)); self.assertTrue(active_free()); t.assertClean(self)
        with patch.object(svc, 'export_image', side_effect=RuntimeError(SECRET)):
            status, _, data = self.call('/api/paper/images/export', body=export_request())
        self.assertEqual(status, 500); self.assertNotIn('SECRET', json.dumps(data, ensure_ascii=False)); self.assertTrue(active_free())
    def test_capabilities_descriptor(self):
        status, _, caps = self.call('/api/capabilities', 'GET')
        self.assertEqual(status, 200); self.assertEqual(caps['imageEditor'], svc.capability())
        self.assertEqual(set(caps['imageEditor']), {'available', 'schema'})
        with patch.object(svc, 'ENGINE', Path(tempfile.gettempdir()) / 'falsify-missing-engine.py'):
            status, _, caps = self.call('/api/capabilities', 'GET')
        self.assertEqual(caps['imageEditor'], {'available': False, 'schema': 'falsify.image-list.v1'})
        self.assertIn('paperAnalysis', caps); self.assertIn('pdfEditor', caps)

def svc_routes(): return list(server.IMAGE_ROUTES)

if __name__ == '__main__': unittest.main()
