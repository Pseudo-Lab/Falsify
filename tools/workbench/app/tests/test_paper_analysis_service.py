"""Advisory PDF preflight inspection (POST /api/paper/inspect): strict request and summary contract, isolated child with a
rehash, temporary-copy cleanup and admission like export. Synthetic PDFs, ephemeral ports and fake runners only; never invokes
Codex, Claude or any model and never touches a server on 7816. Assertions avoid echoing token contents. Global ACTIVE/JOBS are
restored after every test."""
import base64
import hashlib
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
LOCAL = Path(__file__).resolve().parents[1] / 'local'
ROOT_VERSION = (Path(__file__).resolve().parents[2] / 'VERSION').read_text(encoding='ascii').strip()
sys.path.insert(0, str(LOCAL))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
import paper_analysis_service as svc
try:
    import pymupdf
    import pdf_foundation_corpus as corpus
except ImportError:
    pymupdf = corpus = None

WEB = 'https://shinick-han.github.io'
SECRET = 'SECRET-source-sentence /tmp/private.pdf Traceback'
TOP_KEYS = {'schema', 'sourceSha256', 'status', 'inventory', 'objects', 'layout', 'structure', 'limits'}
MINIMAL = b'%PDF-1.4\n% synthetic bytes, not a readable document\n'
PATCH = {'id': 'e0', 'pageIndex': 0, 'before': 'holds', 'after': 'stays'}
VOCABULARY = TOP_KEYS | set(svc.INVENTORY_KEYS) | set(svc.OBJECT_KEYS) | svc.OVERFLOW_REASONS | svc.UNSUPPORTED_REASONS \
    | set(svc.LIMITATIONS) | {svc.SCHEMA, 'available', 'partial', 'unavailable', 'fits', 'overflow', 'unsupported', 'id', 'reason',
    'conversion_unconfigured'}
needs_pymupdf = unittest.skipUnless(pymupdf, 'PyMuPDF not installed')

def sha(data): return hashlib.sha256(data).hexdigest()

def request(source, patches=(), **over):
    data = {'schema': svc.REQUEST_SCHEMA, 'fileHash': sha(source), 'file': base64.b64encode(source).decode('ascii'),
        'patches': [dict(p) for p in patches]}
    data.update(over)
    return data

def leaves(value):
    if isinstance(value, dict): return [x for k, v in value.items() for x in [k, *leaves(v)]]
    if isinstance(value, list): return [x for v in value for x in leaves(v)]
    return [value]

def good_envelope(source_sha256, ids):
    return {'schema': svc.ENVELOPE_SCHEMA, 'sourceSha256': source_sha256,
        'inventory': {'available': True, 'pages': 1, 'textLines': 3, 'images': 1, 'vectors': 0, 'truncated': False},
        'objects': {'available': True, 'images': 1, 'sharedImages': 0, 'inlineImages': 0, 'vectors': 0, 'ambiguous': 0, 'inspected': 1,
            'complete': True},
        'layout': [{'id': i, 'status': 'fits', 'reason': None} for i in ids]}

def stdout_of(envelope): return (json.dumps(envelope) + '\n').encode('utf-8')

class Runner:
    """Fake child: records the call and what the private copy held, then answers with fixed stdout or raises."""
    def __init__(self, stdout=b'', returncode=0, error=None, hook=None):
        self.stdout, self.returncode, self.error, self.hook, self.calls = stdout, returncode, error, hook, []
    def __call__(self, argv, *, input, cwd, env, timeout):
        copy = Path(cwd) / 'source.pdf'
        self.calls.append({'argv': argv, 'input': input, 'cwd': cwd, 'env': env, 'timeout': timeout,
            'copy': copy.read_bytes() if copy.is_file() else None})
        if self.hook: self.hook()
        if self.error: raise self.error
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, None)

class TempTracker:
    """Records every private working directory the service creates."""
    def __enter__(self):
        real, self.dirs = tempfile.mkdtemp, []
        def make(*a, **k):
            d = real(*a, **k); self.dirs.append(d); return d
        self.patch = patch.object(svc.tempfile, 'mkdtemp', make); self.patch.start(); return self
    def __exit__(self, *exc): self.patch.stop()

class ContractAsserts:
    def assertPublic(self, summary, source_sha256, ids):
        self.assertEqual(set(summary), TOP_KEYS)
        self.assertEqual((summary['schema'], summary['sourceSha256']), (svc.SCHEMA, source_sha256))
        self.assertIn(summary['status'], ('available', 'partial', 'unavailable'))
        self.assertEqual(list(summary['inventory']), list(svc.INVENTORY_KEYS))
        self.assertEqual(list(summary['objects']), list(svc.OBJECT_KEYS))
        for section in (summary['inventory'], summary['objects']):
            for k, v in section.items():
                if k in ('truncated', 'complete'): self.assertIs(type(v), bool)
                else: self.assertIs(type(v), int); self.assertGreaterEqual(v, 0)
        self.assertEqual([e['id'] for e in summary['layout']], ids)
        for e in summary['layout']:
            self.assertEqual(set(e), {'id', 'status', 'reason'})
            if e['status'] == 'fits': self.assertIsNone(e['reason'])
            elif e['status'] == 'overflow': self.assertIn(e['reason'], svc.OVERFLOW_REASONS)
            else: self.assertEqual(e['status'], 'unsupported'); self.assertIn(e['reason'], svc.UNSUPPORTED_REASONS)
        self.assertEqual(summary['structure'], {'status': 'unavailable', 'reason': 'conversion_unconfigured'})
        self.assertEqual(summary['limits'], ['hint-only', 'text-only-blue', 'no-object-export'])
        # Only fixed vocabulary, the bound hash and the request's own ids: no free strings, no coordinates or other floats.
        for leaf in leaves(summary):
            self.assertNotIsInstance(leaf, float)
            if isinstance(leaf, str): self.assertIn(leaf, VOCABULARY | {source_sha256, *ids})
    def assertUnavailable(self, summary, source_sha256, ids):
        self.assertPublic(summary, source_sha256, ids)
        self.assertEqual(summary, svc.unavailable_summary(source_sha256, [{'id': i} for i in ids]))
        self.assertEqual(summary['status'], 'unavailable')
        self.assertEqual(summary['layout'], [{'id': i, 'status': 'unsupported', 'reason': 'probe-error'} for i in ids])

class RequestValidationTests(unittest.TestCase):
    def assertCode(self, data, code):
        with self.assertRaises(ValueError) as caught: svc.validate_request(data)
        self.assertEqual(str(caught.exception), code)
    def test_exact_request_accepted(self):
        self.assertEqual(svc.validate_request(request(MINIMAL)), (MINIMAL, sha(MINIMAL), []))
        twelve = [dict(PATCH, id=f'p.{i}_x-{i}', pageIndex=i) for i in range(12)]
        self.assertEqual(svc.validate_request(request(MINIMAL, twelve))[2], twelve)
        self.assertEqual(len(svc.validate_request(request(MINIMAL, [dict(PATCH, after='x' * 4000)]))[2]), 1)
    def test_request_shape(self):
        good = request(MINIMAL)
        for i, data in enumerate([[], 'x', None, {k: v for k, v in good.items() if k != 'patches'}, dict(good, extra=1),
                dict(good, schema='falsify.pdf-analysis-request.v2'), dict(good, schema=None), dict(good, path='C:/x.pdf')]):
            with self.subTest(case=i): self.assertCode(data, 'invalid_request')
    def test_malformed_base64_and_pdf(self):
        encoded = base64.b64encode(MINIMAL).decode('ascii')
        five = base64.b64encode(b'%PDF-').decode('ascii')   # 'JVBERi0='; other discarded low bits decode the same: non-canonical
        cases = {'not text': 1, 'empty': '', 'alphabet': encoded[:-4] + '!!!!', 'newline': encoded[:8] + '\n' + encoded[8:],
            'space': ' ' + encoded, 'missing padding': five.rstrip('='), 'non-canonical': five[:-2] + '1=',
            'non-ascii': '\uff2a' + encoded[1:], 'not a pdf': base64.b64encode(b'hello world').decode('ascii'),
            'data url': 'data:application/pdf;base64,' + encoded, 'url-safe': base64.urlsafe_b64encode(b'%PDF-\xfb\xff').decode('ascii')}
        for name, value in cases.items():
            with self.subTest(case=name):
                data = request(MINIMAL); data['file'] = value
                self.assertCode(data, 'invalid_file')
        with patch.dict(svc.LIMITS, {'maxPdfBytes': len(MINIMAL) - 1}): self.assertCode(request(MINIMAL), 'invalid_file')
    def test_hash_binding(self):
        for value in [sha(MINIMAL).upper(), sha(MINIMAL)[:63], sha(MINIMAL) + '0', None, 7, ' ' + sha(MINIMAL)[1:]]:
            with self.subTest(value=value): self.assertCode(request(MINIMAL, fileHash=value), 'invalid_file_hash')
        self.assertCode(request(MINIMAL, fileHash=sha(MINIMAL + b'x')), 'source_hash_mismatch')
    def test_patch_shape(self):
        bad = [None, 'x', {'patches': []}, [dict(PATCH, id=f'p{i}') for i in range(13)], [dict(PATCH, extra=1)],
            [{k: v for k, v in PATCH.items() if k != 'after'}], [dict(PATCH, pageIndex=True)], [dict(PATCH, pageIndex=False)],
            [dict(PATCH, pageIndex=0.0)], [dict(PATCH, pageIndex=-1)], [dict(PATCH, pageIndex=10000)], [dict(PATCH, pageIndex='0')],
            [dict(PATCH, id='')], [dict(PATCH, id='a b')], [dict(PATCH, id='x' * 65)], [dict(PATCH, id='\u00e9')], [dict(PATCH, id='a/b')],
            [dict(PATCH, id=1)], [dict(PATCH, id='e0\n')], [dict(PATCH, before='')], [dict(PATCH, after=' \n ')],
            [dict(PATCH, after='x' * 4001)], [dict(PATCH, before=None)], [dict(PATCH, after=['x'])], [dict(PATCH, after='\ud800')],
            [PATCH, dict(PATCH, pageIndex=1)], [PATCH, 'x']]
        for i, patches in enumerate(bad):
            with self.subTest(case=i):
                data = request(MINIMAL); data['patches'] = patches
                self.assertCode(data, 'invalid_patches')
    def test_errors_never_echo_request_text(self):
        with self.assertRaises(ValueError) as caught: svc.validate_request(request(MINIMAL, [dict(PATCH, before=SECRET, id='bad id')]))
        self.assertNotIn('SECRET', str(caught.exception))

class EnvelopeTests(ContractAsserts, unittest.TestCase):
    ids = ['e0', 'e1']
    def setUp(self):
        self.request = svc.validate_request(request(MINIMAL, [PATCH, dict(PATCH, id='e1', pageIndex=1)]))
        self.sha = sha(MINIMAL)
    def run_with(self, runner):
        with TempTracker() as temps: summary = svc.analyze(self.request, runner=runner)
        self.assertEqual(len(temps.dirs), 1)
        self.assertFalse(os.path.exists(temps.dirs[0]), 'private source copy left behind')
        return summary
    def test_well_formed_envelope_published_exactly(self):
        summary = self.run_with(Runner(stdout_of(good_envelope(self.sha, self.ids))))
        self.assertPublic(summary, self.sha, self.ids)
        self.assertEqual(summary['status'], 'available')
        self.assertEqual(summary['inventory'], {'pages': 1, 'textLines': 3, 'images': 1, 'vectors': 0, 'truncated': False})
        self.assertEqual(summary['objects']['inspected'], 1)
        self.assertEqual(summary['layout'], [{'id': 'e0', 'status': 'fits', 'reason': None}, {'id': 'e1', 'status': 'fits', 'reason': None}])
    def test_partial_and_unavailable_status(self):
        for mutate in [lambda e: e['inventory'].update(truncated=True), lambda e: e['objects'].update(complete=False),
                lambda e: e.update(objects={'available': False, **svc._empty(svc.OBJECT_KEYS)})]:
            envelope = good_envelope(self.sha, self.ids); mutate(envelope)
            self.assertEqual(self.run_with(Runner(stdout_of(envelope)))['status'], 'partial')
        envelope = good_envelope(self.sha, self.ids)
        envelope.update(inventory={'available': False, **svc._empty(svc.INVENTORY_KEYS)}, objects={'available': False, **svc._empty(svc.OBJECT_KEYS)})
        summary = self.run_with(Runner(stdout_of(envelope)))
        self.assertEqual((summary['status'], summary['layout'][0]['status']), ('unavailable', 'fits'))
    def test_tampered_envelopes_fall_back_to_unavailable(self):
        def edit(path, value):
            def apply(e):
                target = e
                for k in path[:-1]: target = target[k]
                target[path[-1]] = value
            return apply
        fits = lambda i: {'id': i, 'status': 'fits', 'reason': None}
        mutations = {'extra text': edit(['text'], SECRET), 'extra inventory key': edit(['inventory', 'fonts'], [SECRET]),
            'occurrences': edit(['objects', 'occurrences'], [{'bbox': [1.5, 2.5, 3.5, 4.5], 'xref': 12}]),
            'float count': edit(['inventory', 'pages'], 1.0), 'bool count': edit(['objects', 'images'], True),
            'negative': edit(['inventory', 'textLines'], -1), 'over cap': edit(['objects', 'vectors'], 10 ** 9),
            'string count': edit(['inventory', 'images'], SECRET), 'int flag': edit(['objects', 'complete'], 1),
            'string flag': edit(['inventory', 'truncated'], 'false'), 'hash': edit(['sourceSha256'], sha(b'other')),
            'schema': edit(['schema'], svc.SCHEMA), 'swapped ids': edit(['layout'], [fits('e1'), fits('e0')]),
            'layout coordinates': edit(['layout'], [dict(fits('e0'), bbox=[1, 2, 3, 4]), fits('e1')]),
            'short layout': edit(['layout'], [fits('e0')]), 'layout dict': edit(['layout'], {}),
            'unavailable with counts': edit(['inventory', 'available'], False), 'shared over images': edit(['objects', 'sharedImages'], 2),
            'classified over total': edit(['objects', 'ambiguous'], 5), 'available string': edit(['objects', 'available'], 'yes')}
        for name, mutate in mutations.items():
            with self.subTest(case=name):
                envelope = good_envelope(self.sha, self.ids); mutate(envelope)
                summary = self.run_with(Runner(stdout_of(envelope)))
                self.assertUnavailable(summary, self.sha, self.ids); self.assertNotIn('SECRET', json.dumps(summary))
        for value in [[], 'x', None, 7, {}]:
            with self.subTest(envelope=value): self.assertUnavailable(self.run_with(Runner(stdout_of(value))), self.sha, self.ids)
    def test_unknown_layout_reasons_become_probe_error(self):
        cases = [('unsupported', SECRET), ('fits', 'height'), ('overflow', 'missing-glyphs'), ('unsupported', 'height'), ('overflow', None),
            ('garbage', None), (None, 'probe-error'), ('fits', ''), ('unsupported', ['source-not-simple']), ('overflow', {'kind': 'height'}),
            ('unsupported', 'Source-Not-Simple'), (['fits'], None), ('unsupported', 'caller-font-object')]
        for status, reason in cases:
            with self.subTest(status=status, reason=reason):
                envelope = good_envelope(self.sha, self.ids); envelope['layout'][0].update(status=status, reason=reason)
                summary = self.run_with(Runner(stdout_of(envelope)))
                self.assertPublic(summary, self.sha, self.ids)
                self.assertEqual(summary['layout'][0], {'id': 'e0', 'status': 'unsupported', 'reason': 'probe-error'})
                self.assertEqual(summary['status'], 'available'); self.assertNotIn('SECRET', json.dumps(summary))
        for status, reason in [('overflow', 'height'), ('overflow', 'unbreakable-width'), ('unsupported', 'source-not-simple'),
                ('unsupported', 'missing-glyphs'), ('unsupported', 'line-bands-overlap')]:
            envelope = good_envelope(self.sha, self.ids); envelope['layout'][0].update(status=status, reason=reason)
            self.assertEqual(self.run_with(Runner(stdout_of(envelope)))['layout'][0], {'id': 'e0', 'status': status, 'reason': reason})
    def test_transport_failures_fall_back_and_clean_up(self):
        good = stdout_of(good_envelope(self.sha, self.ids))
        runners = {'nonzero exit': Runner(good, returncode=1), 'two lines': Runner(good + good), 'empty': Runner(b''),
            'traceback': Runner(good + b'Traceback: ' + SECRET.encode() + b'\n'), 'invalid utf-8': Runner(b'\xff\xfe\n'),
            'nan': Runner(good.replace(b'"pages": 1', b'"pages": NaN')),
            'duplicate key': Runner(good.replace(b'"pages": 1', b'"pages": 1, "pages": 1')),
            'oversized': Runner(good.rstrip(b'\n') + b' ' * (svc.LIMITS['maxStdoutBytes'] + 1) + b'\n'),
            'timeout': Runner(error=subprocess.TimeoutExpired(['python'], 60)), 'os error': Runner(error=OSError(SECRET)),
            'runtime error': Runner(error=RuntimeError(SECRET)), 'not bytes': Runner(good.decode('utf-8'))}
        for name, runner in runners.items():
            with self.subTest(case=name):
                summary = self.run_with(runner)
                self.assertUnavailable(summary, self.sha, self.ids); self.assertNotIn('SECRET', json.dumps(summary))
    def test_child_invocation_fixed_isolated_minimal(self):
        runner = Runner(stdout_of(good_envelope(self.sha, self.ids)))
        with patch.dict(os.environ, {'FALSIFY_TEST_SECRET': 'x', 'PYTHONPATH': 'C:/evil', 'PYTHONSTARTUP': 'C:/evil.py'}):
            self.run_with(runner)
        call, = runner.calls
        self.assertEqual(call['argv'], [sys.executable, '-I', str((LOCAL / 'paper_analysis_service.py').resolve()), '--worker'])
        self.assertEqual(call['timeout'], 60)
        self.assertLessEqual(set(call['env']), set(svc.ENV_ALLOW))
        self.assertFalse({'FALSIFY_TEST_SECRET', 'PYTHONPATH', 'PYTHONSTARTUP'} & set(call['env']))
        self.assertEqual(call['copy'], MINIMAL)
        stdin = json.loads(call['input'])
        self.assertEqual(set(stdin), {'source', 'sourceSha256', 'patches'})
        self.assertEqual((Path(stdin['source']).parent, stdin['sourceSha256']), (Path(call['cwd']), self.sha))
        self.assertNotIn(base64.b64encode(MINIMAL).decode('ascii'), call['input'].decode('ascii'))
    def test_request_bytes_never_mutated(self):
        data = request(MINIMAL, [PATCH]); frozen = json.dumps(data)
        def scribble(): (Path(runner.calls[0]['cwd']) / 'source.pdf').write_bytes(b'%PDF-overwritten')
        runner = Runner(stdout_of(good_envelope(self.sha, ['e0'])), hook=scribble)
        with TempTracker(): svc.inspect(data, runner=runner)
        self.assertEqual(json.dumps(data), frozen); self.assertEqual(base64.b64decode(data['file']), MINIMAL)
    def test_parent_imports_no_model_or_network_backend(self):
        source = (LOCAL / 'paper_analysis_service.py').read_text(encoding='utf-8')
        for name in ('cli_backend', 'harness', 'red_service', 'blue_service', 'editor_service', 'docling', 'urllib', 'socket', 'pymupdf'):
            self.assertNotIn('import ' + name, source)
        self.assertEqual(set(svc.capability()), {'available', 'schema'}); self.assertEqual(svc.capability()['schema'], svc.SCHEMA)

@needs_pymupdf
class RealChildTests(ContractAsserts, unittest.TestCase):
    def inspect(self, source, patches):
        data = request(source, patches)
        with TempTracker() as temps: summary = svc.inspect(data)
        self.assertEqual(len(temps.dirs), 1); self.assertFalse(os.path.exists(temps.dirs[0]))
        self.assertEqual(base64.b64decode(data['file']), source)
        self.assertNotIn('falsify-inspect', json.dumps(summary))
        return summary
    def test_shared_image_summary_hash_and_layout(self):
        case = corpus.build_case('shared_image_occurrence'); source = bytes(case['source']); before = bytes(source)
        edit = dict(case['edits'][0], id='e0')
        summary = self.inspect(source, [edit])
        self.assertPublic(summary, sha(source), ['e0'])
        self.assertEqual(source, before)
        self.assertEqual(summary['status'], 'available')
        self.assertEqual(summary['inventory']['pages'], case['pageCount']['source']); self.assertFalse(summary['inventory']['truncated'])
        self.assertGreater(summary['inventory']['textLines'], 0)
        objects = summary['objects']
        self.assertEqual((objects['images'], objects['sharedImages'], objects['inlineImages'], objects['complete']), (2, 2, 0, True))
        self.assertEqual((objects['inspected'], objects['ambiguous']), (0, 2))
        self.assertEqual(summary['layout'], [{'id': 'e0', 'status': 'overflow', 'reason': 'height'}])
        text = json.dumps(summary)
        for private in (edit['before'], edit['after'], 'Helvetica', 'helv', 'xref', 'bbox'): self.assertNotIn(private, text)
    def test_selected_layout_fits_unsupported_and_out_of_range(self):
        case = corpus.build_case('valid_same_length_wording'); source = bytes(case['source'])
        edit = case['edits'][0]
        patches = [dict(edit, id='fit'), dict(edit, id='far', pageIndex=9999), dict(edit, id='nope', before='text that is not on the page')]
        summary = self.inspect(source, patches)
        self.assertPublic(summary, sha(source), ['fit', 'far', 'nope'])
        self.assertEqual([(e['status'], e['reason']) for e in summary['layout']],
            [('fits', None), ('unsupported', 'source-not-simple'), ('unsupported', 'source-not-simple')])
        multiline = corpus.build_case('multiline_mixed_font')
        summary = self.inspect(bytes(multiline['source']), [dict(multiline['edits'][0], id='m')])
        self.assertEqual(summary['layout'], [{'id': 'm', 'status': 'unsupported', 'reason': 'source-not-simple'}])
    def test_zero_patches_and_unreadable_pdf(self):
        source = bytes(corpus.build_case('valid_same_length_wording')['source'])
        summary = self.inspect(source, [])
        self.assertPublic(summary, sha(source), []); self.assertEqual((summary['status'], summary['layout']), ('available', []))
        summary = self.inspect(MINIMAL, [PATCH])
        self.assertPublic(summary, sha(MINIMAL), ['e0']); self.assertEqual(summary['status'], 'unavailable')
        self.assertEqual((summary['inventory'], summary['objects']), (svc._empty(svc.INVENTORY_KEYS), svc._empty(svc.OBJECT_KEYS)))
    def test_mupdf_stdout_errors_do_not_hide_a_readable_source(self):
        doc = pymupdf.open(); doc.new_page().insert_text((72, 72), 'Hello world', fontsize=11); good = doc.tobytes(deflate=True)
        start = good.index(b'stream\n') + len(b'stream\n')
        source = good[:start] + b'\x00garbage' + good[start + 8:]   # broken content stream: MuPDF prints a recoverable error
        summary = self.inspect(source, [])
        self.assertPublic(summary, sha(source), [])
        self.assertEqual((summary['status'], summary['inventory']['pages'], summary['objects']['complete']), ('available', 1, True))
    def test_child_rehashes_the_private_copy(self):
        case = corpus.build_case('valid_same_length_wording'); source = bytes(case['source'])
        other = bytes(corpus.build_case('shared_image_occurrence')['source'])
        def swapped(argv, *, input, cwd, env, timeout):
            (Path(cwd) / 'source.pdf').write_bytes(other)
            return svc.default_runner(argv, input=input, cwd=cwd, env=env, timeout=timeout)
        summary = svc.inspect(request(source, [dict(case['edits'][0], id='e0')]), runner=swapped)
        self.assertUnavailable(summary, sha(source), ['e0'])
    def test_child_ignores_shadow_modules_in_working_directory(self):
        case = corpus.build_case('valid_same_length_wording'); source = bytes(case['source'])
        def shadowed(argv, *, input, cwd, env, timeout):
            for name in ('paper_inventory', 'pdf_object_probe', 'pdf_layout_probe', 'pymupdf', 'json'):
                (Path(cwd) / (name + '.py')).write_text('import sys\nsys.stdout.write("SHADOW\\n")\nraise SystemExit(7)\n', encoding='utf-8')
            return svc.default_runner(argv, input=input, cwd=cwd, env=dict(env, PYTHONPATH=cwd), timeout=timeout)
        with TempTracker() as temps: summary = svc.inspect(request(source, [dict(case['edits'][0], id='e0')]), runner=shadowed)
        self.assertFalse(os.path.exists(temps.dirs[0]))
        self.assertEqual((summary['status'], summary['layout'][0]['status']), ('available', 'fits'))
    def test_real_timeout_cleans_up(self):
        case = corpus.build_case('valid_same_length_wording'); source = bytes(case['source'])
        with patch.dict(svc.LIMITS, {'timeoutSeconds': 0.001}), TempTracker() as temps:
            summary = svc.inspect(request(source, [dict(case['edits'][0], id='e0')]))
        self.assertUnavailable(summary, sha(source), ['e0']); self.assertFalse(os.path.exists(temps.dirs[0]))

def active_free():
    if not server.ACTIVE.acquire(blocking=False): return False
    server.ACTIVE.release(); return True

class ServerTests(ContractAsserts, unittest.TestCase):
    def setUp(self):
        self.assertTrue(active_free(), 'ACTIVE leaked from an earlier test')
        jobs = patch.dict(server.JOBS, clear=True); jobs.start(); self.addCleanup(jobs.stop)
        def no_model(*a, **k): raise AssertionError('inspection must never start a RED/BLUE model review')
        for name in ('run_review', 'run_blue_review'):
            p = patch.object(server, name, no_model); p.start(); self.addCleanup(p.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler); self.http.daemon_threads = True
        self.http.web_origin = WEB; self.port = self.http.server_port
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(self.stop)
        self.data = request(MINIMAL, [PATCH]); self.sha = sha(MINIMAL)
    def stop(self):
        if self.thread.is_alive(): self.http.shutdown()
        self.thread.join(5); self.http.server_close()
        self.assertTrue(active_free(), 'ACTIVE still held after server_close')
    def call(self, path='/api/paper/inspect', method='POST', body=None, origin=WEB, token=True, headers=None, host=None,
            content_type='application/json'):
        h = {'Host': host or f'127.0.0.1:{self.port}'}
        if origin is not None: h['Origin'] = origin
        if token is True: h['Authorization'] = 'Bearer ' + server.TOKEN
        elif token: h['Authorization'] = token
        if body is not None and content_type: h['Content-Type'] = content_type
        h.update(headers or {})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, path, body=json.dumps(body).encode() if isinstance(body, (dict, list)) else body, headers=h)
            res = conn.getresponse(); raw = res.read()
        finally: conn.close()
        data = json.loads(raw) if res.getheader('Content-Type', '').startswith('application/json') else raw
        return res.status, {k.lower(): v for k, v in res.getheaders()}, data
    def fake(self, runner):
        p = patch.object(svc, 'default_runner', runner); p.start(); self.addCleanup(p.stop); return runner
    def test_preflight_allowlist(self):
        status, h, _ = self.call(method='OPTIONS', token=False, headers={'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type'})
        self.assertEqual(status, 204); self.assertEqual(h['access-control-allow-origin'], WEB)
        self.assertEqual(h['access-control-allow-methods'], 'POST')
        p = '/api/paper/inspect'
        for method, hdrs, origin, path in [('GET', 'authorization', WEB, p), ('PUT', 'authorization', WEB, p),
                ('POST', 'authorization, x-falsify-launcher', WEB, p), ('POST', 'authorization', 'https://attacker.example', p),
                ('POST', 'authorization', 'null', p), ('POST', 'authorization', WEB, p + '/'), ('POST', 'authorization', WEB, '/api/paper/convert'),
                ('POST', 'authorization', WEB, '/api/paper/run')]:
            with self.subTest(method=method, origin=origin, path=path):
                status, h, _ = self.call(path, 'OPTIONS', origin=origin, token=False, headers={'Access-Control-Request-Method': method,
                    'Access-Control-Request-Headers': hdrs})
                self.assertEqual(status, 403); self.assertNotIn('access-control-allow-origin', h)
    def test_unauthorized_and_foreign_origin_never_run(self):
        runner = self.fake(Runner(stdout_of(good_envelope(self.sha, ['e0']))))
        for name, kw in [('no token', {'token': False}), ('wrong token', {'token': 'Bearer wrong'}), ('bare token', {'token': server.TOKEN}),
                ('foreign origin', {'origin': 'https://attacker.example'}), ('null origin', {'origin': 'null'}),
                ('http origin', {'origin': 'http://shinick-han.github.io'}), ('localhost host', {'host': f'localhost:{self.port}'}),
                ('remote host', {'host': 'shinick-han.github.io'})]:
            with self.subTest(case=name):
                status, h, _ = self.call(body=self.data, **kw)
                self.assertEqual(status, 403)
                if 'origin' in kw or 'host' in kw: self.assertNotIn('access-control-allow-origin', h)
        self.assertEqual(runner.calls, [])
        status, h, _ = self.call('/api/paper/inspect', 'GET')   # not a CORS route for GET: refused before any lookup
        self.assertEqual(status, 403); self.assertNotIn('access-control-allow-origin', h)
        status, h, _ = self.call('/api/paper/inspect', 'GET', origin=f'http://127.0.0.1:{self.port}')
        self.assertEqual(status, 404); self.assertEqual(runner.calls, [])
    def test_body_limits_and_invalid_requests(self):
        runner = self.fake(Runner(stdout_of(good_envelope(self.sha, ['e0']))))
        self.assertEqual(self.call(body=self.data, content_type='text/plain')[0], 400)
        status, h, _ = self.call(body=b'{"schema":1,"schema":2}')
        self.assertEqual(status, 400); self.assertEqual(h['access-control-allow-origin'], WEB)
        status, _, data = self.call(body=dict(self.data, fileHash=sha(b'x'))); self.assertEqual((status, data), (400, {'error': 'source_hash_mismatch'}))
        status, _, data = self.call(body=dict(self.data, patches=[dict(PATCH, before=SECRET, pageIndex=True)]))
        self.assertEqual((status, data), (400, {'error': 'invalid_patches'}))
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.putrequest('POST', '/api/paper/inspect', skip_host=True, skip_accept_encoding=True)
            for k, v in [('Host', f'127.0.0.1:{self.port}'), ('Origin', WEB), ('Authorization', 'Bearer ' + server.TOKEN),
                    ('Content-Type', 'application/json'), ('Content-Length', str(37 * 1024 * 1024 + 1))]: conn.putheader(k, v)
            conn.endheaders(); res = conn.getresponse(); res.read()
        finally: conn.close()
        self.assertEqual(res.status, 400)
        self.assertEqual(runner.calls, []); self.assertTrue(active_free())
    def test_inspect_through_web_origin_keeps_jobs(self):
        runner = self.fake(Runner(stdout_of(good_envelope(self.sha, ['e0']))))
        retained = {'id': 'kept', 'role': 'red', 'state': 'completed', 'cancel': threading.Event(), 'result': {'x': 1}, 'finished': time.monotonic()}
        server.JOBS['kept'] = retained
        status, h, data = self.call(body=self.data)
        self.assertEqual(status, 200); self.assertEqual(h['access-control-allow-origin'], WEB); self.assertEqual(h['cache-control'], 'no-store')
        self.assertPublic(data, self.sha, ['e0']); self.assertEqual(data['status'], 'available')
        self.assertEqual(len(runner.calls), 1); self.assertEqual(server.JOBS, {'kept': retained}); self.assertTrue(active_free())
        self.assertFalse(retained['cancel'].is_set())
        status, h, _ = self.call(body=self.data, origin=f'http://127.0.0.1:{self.port}')
        self.assertEqual(status, 200); self.assertNotIn('access-control-allow-origin', h)
    def test_busy_closing_and_restart_reserved_refuse(self):
        runner = self.fake(Runner(stdout_of(good_envelope(self.sha, ['e0']))))
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        try:
            status, h, data = self.call(body=self.data)
            self.assertEqual((status, data), (409, {'error': 'companion_busy'})); self.assertEqual(h['access-control-allow-origin'], WEB)
        finally: server.ACTIVE.release()
        self.http.closing = True
        try: self.assertEqual(self.call(body=self.data)[:3:2], (409, {'error': 'companion_busy'}))
        finally: self.http.closing = False
        with server.LOCK:
            self.assertTrue(server.ACTIVE.acquire(blocking=False)); self.http.closing = True; self.http.restart_reserved = True
        self.assertEqual(self.call(body=self.data)[0], 409)
        self.assertEqual(runner.calls, [])   # stop(): server_close releases the reservation
    def test_restart_race_while_inspecting(self):
        entered, release = threading.Event(), threading.Event()
        def hold(): entered.set(); release.wait(10)
        self.fake(Runner(stdout_of(good_envelope(self.sha, ['e0'])), hook=hold))
        result = {}
        worker = threading.Thread(target=lambda: result.update(response=self.call(body=self.data)), daemon=True); worker.start()
        try:
            self.assertTrue(entered.wait(10))
            launcher = {'X-Falsify-Launcher': '1'}
            status, _, data = self.call('/api/launcher/instance', 'GET', origin=None, headers=launcher)
            self.assertEqual((status, data['busy']), (200, True))
            status, _, data = self.call('/api/launcher/restart', body={'schema': server.LIFECYCLE_SCHEMA, 'instanceId': self.http.instance_id},
                origin=None, headers=launcher)
            self.assertEqual((status, data), (409, {'error': 'companion_busy'})); self.assertFalse(self.http.closing)
            self.assertEqual(self.call(body=self.data)[:3:2], (409, {'error': 'companion_busy'}))
        finally: release.set()
        worker.join(10)
        self.assertEqual(result['response'][0], 200); self.assertTrue(active_free())
    def test_capabilities_and_optional_dependency_absence(self):
        status, _, caps = self.call('/api/capabilities', 'GET')
        self.assertEqual(status, 200); self.assertEqual(caps['workbenchVersion'], ROOT_VERSION)
        self.assertEqual(caps['paperAnalysis'], {'available': svc.capability()['available'], 'schema': 'falsify.pdf-analysis-summary.v1'})
        pdf = caps['pdf']
        with patch.object(svc.importlib.util, 'find_spec', lambda name, *a: None):
            status, _, caps = self.call('/api/capabilities', 'GET')
        self.assertEqual(caps['paperAnalysis'], {'available': False, 'schema': svc.SCHEMA}); self.assertEqual(caps['pdf'], pdf)
        self.fake(Runner(b'', returncode=1))
        status, _, data = self.call(body=self.data)
        self.assertEqual(status, 200); self.assertUnavailable(data, self.sha, ['e0'])
        with patch.object(server, 'handle_export', lambda d: {'synthetic': True}):
            status, _, data = self.call('/api/export', body={'format': 'PDF'})
        self.assertEqual((status, data), (200, {'synthetic': True})); self.assertTrue(active_free())
    @needs_pymupdf
    def test_real_child_through_http(self):
        case = corpus.build_case('valid_same_length_wording'); source = bytes(case['source'])
        status, _, data = self.call(body=request(source, [dict(case['edits'][0], id='e0')]))
        self.assertEqual(status, 200); self.assertPublic(data, sha(source), ['e0'])
        self.assertEqual((data['status'], data['layout'][0]['status']), ('available', 'fits'))

if __name__ == '__main__': unittest.main()
