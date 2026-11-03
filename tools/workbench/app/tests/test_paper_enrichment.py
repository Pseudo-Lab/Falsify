"""Synthetic-PDF integration tests for paper enrichment.

The OCR and chart engines are injected. No model package, weight download,
or paper_enrichment child worker is started. Fixtures are built in memory.
"""
import ast
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import anyio
import pymupdf
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_enrichment as enrichment
import paper_evidence as evidence
import paper_evidence_blue as blue
import paper_mcp

LOCAL = Path(__file__).resolve().parents[1] / 'local'
OCR_BOX = [72, 100, 216, 244]
CHART_BOX = [400, 500, 520, 640]
BASE_TOOLS = {'status', 'list_items', 'read_item', 'render_region'}
ANALYSIS_TOOLS = {'list_analyses', 'read_analysis', 'ocr_page', 'extract_chart', 'digitize_points'}
HEAVY = ('torch', 'transformers', 'rapidocr', 'img2table', 'cv2', 'onnxruntime', 'paddle', 'paper_ocr', 'paper_chart')
SENTINEL = 'SENTINEL_FILE_BYTES'
CHILD = r'''
import hashlib, json, struct, sys
from pathlib import Path

local, pdf_path, flag_path = sys.argv[1:4]
sys.path.insert(0, local)
import paper_enrichment

calls = []

def png_size(png):
    return struct.unpack(">II", png[16:24])

def runner(kind, png, language, cancelled):
    calls.append({"kind": kind, "language": language})
    width, height = png_size(png)
    image = {"sha256": hashlib.sha256(png).hexdigest(), "width": width, "height": height}
    if kind == "ocr":
        return {
            "schema": "falsify.ocr-page.v1", "status": "ready", "image": image, "language": language,
            "lines": [{"id": "l0", "text": "SYNTH-OCR", "confidence": 0.5, "bbox": [0, 0, width, height]}],
            "tables": [], "transforms": [], "issues": [],
            "provenance": {"engine": "injected", "version": "test", "method": "injected", "model": None, "language": language},
        }
    return {
        "schema": "falsify.chart-data.v1", "status": "partial", "image": image,
        "columns": ["label", "value"], "rows": [["A", "1.5"]],
        "numericCells": [{"row": 0, "column": 1, "raw": "1.5", "value": 1.5, "unit": None, "origin": "model-estimate"}],
        "title": "SYNTH-CHART", "chartType": "unknown", "axes": {},
        "provenance": {"engine": "injected", "model": None, "revision": None, "device": None, "method": "injected"},
        "issues": [], "rawOutput": "label | value\nA | 1.5",
    }

paper_enrichment.run_child = runner
import paper_mcp
code = 1
try:
    code = paper_mcp.main(["--pdf", pdf_path, "--analysis"])
finally:
    banned = {"torch", "transformers", "rapidocr", "img2table", "cv2", "onnxruntime", "paddle", "paper_ocr", "paper_chart"}
    heavy = sorted(name for name in sys.modules if name.split(".")[0] in banned)
    Path(flag_path).write_text(json.dumps({"calls": calls, "heavy": heavy, "code": code}), encoding="utf-8")
raise SystemExit(code)
'''


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def png_size(png):
    if not isinstance(png, (bytes, bytearray)) or png[:8] != b'\x89PNG\r\n\x1a\n' or png[12:16] != b'IHDR':
        raise AssertionError('rendered bytes are not a PNG')
    return struct.unpack('>II', png[16:24])


def source_box(region, box, width, height):
    span_x, span_y = region[2] - region[0], region[3] - region[1]
    return [round(region[0] + box[0] / width * span_x, 4), round(region[1] + box[1] / height * span_y, 4),
            round(region[0] + box[2] / width * span_x, 4), round(region[1] + box[3] / height * span_y, 4)]


def page_text(raw):
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        return ''.join(doc[index].get_text() for index in range(doc.page_count))
    finally:
        doc.close()


def synthetic_pdf(stamp='ONE'):
    """In-memory page with one detectable table. No private paper content."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((400, 40), stamp, fontsize=11)
    page.insert_text((72, 78), 'Table 1. Merged', fontsize=11)
    specs = [(0, 0, 1, 1, 'Metric'), (0, 1, 1, 2, 'Groups'), (1, 0, 2, 1, 'span'),
             (1, 1, 1, 1, '1'), (1, 2, 1, 1, '2'), (2, 1, 1, 1, ''), (2, 2, 1, 1, '5')]
    origin, col_w, row_h = (72, 90), 100, 28
    for row, col, row_span, col_span, text in specs:
        rect = pymupdf.Rect(origin[0] + col * col_w, origin[1] + row * row_h,
                            origin[0] + (col + col_span) * col_w, origin[1] + (row + row_span) * row_h)
        page.draw_rect(rect, color=(0, 0, 0), width=1)
        if text:
            page.insert_textbox(pymupdf.Rect(rect.x0 + 3, rect.y0 + 6, rect.x1 - 3, rect.y1 - 3),
                                 text, fontsize=10, fontname='helv')
    data = doc.tobytes()
    doc.close()
    return data


def result_for(kind, language, image, width, height, status):
    if kind == 'ocr':
        return {'schema': 'falsify.ocr-page.v1', 'status': status, 'image': image, 'language': language,
                'lines': [{'id': 'l0', 'text': 'SYNTH-OCR', 'confidence': 0.5, 'bbox': [0, 0, width, height]},
                          {'id': 'l1', 'text': 'OUT', 'confidence': 0.1, 'bbox': [-2, 0, 4, 4]}],
                'tables': [{'bbox': [0, 0, width / 2, height / 2], 'rows': 1, 'columns': 1, 'title': None,
                            'cells': [{'row': 0, 'column': 0, 'text': 'CELL', 'bbox': [0, 0, width / 2, height / 2],
                                       'confidence': None}]}],
                'transforms': [], 'issues': [],
                'provenance': {'engine': 'injected', 'version': 'test', 'method': 'injected', 'model': None, 'language': language}}
    if kind != 'chart':
        raise AssertionError(kind)
    return {'schema': 'falsify.chart-data.v1', 'status': status, 'image': image, 'columns': ['label', 'value'],
            'rows': [['A', '1.5']],
            'numericCells': [{'row': 0, 'column': 1, 'raw': '1.5', 'value': 1.5, 'unit': None, 'origin': 'model-estimate'}],
            'title': 'SYNTH-CHART', 'chartType': 'unknown', 'axes': {},
            'provenance': {'engine': 'injected', 'model': None, 'revision': None, 'device': None, 'method': 'injected'},
            'issues': ['injected'], 'rawOutput': 'label | value\nA | 1.5',
            'tables': [{'bbox': [0, 0, width, height], 'cells': [{'bbox': [1, 1, 2, 2], 'text': '1.5'}]}]}


class Runner:
    def __init__(self):
        self.calls = []
        self.mode = 'ok'
        self.error = 'analysis_worker_failed'
        self.stop_on_cancel = False

    def __call__(self, kind, png, language, cancelled):
        png = bytes(png)
        width, height = png_size(png)
        record = {'kind': kind, 'language': language, 'png': png, 'sha256': sha256(png), 'width': width, 'height': height}
        self.calls.append(record)
        if self.stop_on_cancel:
            if not cancelled.wait(5):
                raise AssertionError('cancel was not signaled')
            raise ValueError('analysis_cancelled')
        if cancelled.is_set():
            raise ValueError('analysis_cancelled')
        if self.mode == 'raise':
            raise ValueError(self.error)
        if self.mode == 'crash':
            raise RuntimeError('injected crash')
        image = {'sha256': record['sha256'], 'width': width, 'height': height}
        if self.mode == 'mismatch':
            image['sha256'] = '0' * 64
        elif self.mode == 'bad-size':
            image['width'] = width + 1
        if self.mode == 'invalid':
            return {'schema': 'falsify.not-a-result.v1', 'status': 'ready', 'image': image}
        status = 'unavailable' if self.mode == 'unavailable' else 'partial' if kind == 'chart' else 'ready'
        return result_for(kind, language, image, width, height, status)


class ActiveSlot:
    """One-slot stand-in for the companion ACTIVE semaphore."""

    def __init__(self):
        self._slot = threading.BoundedSemaphore(1)
        self._lock = threading.Lock()
        self.acquires = 0
        self.releases = 0

    def admit(self):
        with self._lock:
            if not self._slot.acquire(blocking=False):
                return False
            self.acquires += 1
            return True

    def release(self):
        with self._lock:
            self.releases += 1
            self._slot.release()

    def busy(self):
        if not self._slot.acquire(blocking=False):
            return True
        self._slot.release()
        return False


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def wait_job(jobs, job_id, timeout=10):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = jobs.get(job_id)
        if last['state'] != 'running':
            return last
        time.sleep(0.02)
    raise AssertionError(last)


class ImportTests(unittest.TestCase):
    def test_import_does_not_load_model_packages(self):
        source = Path(enrichment.__file__).read_text(encoding='utf-8')
        tree = ast.parse(source)
        imported = []
        for node in tree.body:
            if isinstance(node, ast.Import):
                imported.extend(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module.split('.')[0])
        for name in HEAVY:
            self.assertNotIn(name, imported)
        script = 'import json,sys\nsys.path.insert(0, sys.argv[1])\nbefore=set(sys.modules)\nimport paper_enrichment,paper_digitizer\npaper_enrichment.capability()\nroots={name.split(".")[0] for name in set(sys.modules)-before}\nprint(json.dumps(sorted(roots & set(sys.argv[2].split(",")))))\n'
        completed = subprocess.run([sys.executable, '-c', script, str(LOCAL), ','.join(HEAVY)],
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), '[]')

    def test_capability_and_runtime_path_do_not_spawn(self):
        cap = enrichment.capability()
        self.assertEqual(cap['schema'], 'falsify.paper-analysis.v1')
        self.assertEqual(cap['kinds'], ['ocr', 'chart'])
        self.assertEqual(cap['modelResidency'], 'per-request-child')
        self.assertIs(cap['supported'], True)
        missing = LOCAL / 'missing-paper-analysis-runtime.exe'
        self.assertFalse(missing.exists())
        with patch.dict('os.environ', {'FALSIFY_PAPER_ANALYSIS_PYTHON': str(missing)}):
            with self.assertRaises(ValueError) as caught:
                enrichment.runtime_python()
            self.assertEqual(caught.exception.args[0], 'analysis_runtime_missing')
            failed = enrichment.capability()
        self.assertIs(failed['runtimeConfigured'], False)
        with patch.dict('os.environ', {'FALSIFY_PAPER_ANALYSIS_PYTHON': 'python'}):
            with self.assertRaises(ValueError) as caught:
                enrichment.runtime_python()
            self.assertEqual(caught.exception.args[0], 'analysis_runtime_missing')


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.store = evidence.EvidenceStore(ttl_seconds=3600, max_documents=4, clock=self.clock)
        self.raw = synthetic_pdf('ONE')
        self.digest = sha256(self.raw)
        self.summary = self.store.prepare(self.raw, self.digest)
        self.pid = self.summary['paperId']
        self.runner = Runner()

    def request(self, **extra):
        data = {'paperId': self.pid, 'fileHash': self.digest, 'kind': 'ocr', 'pageIndex': 0}
        data.update(extra)
        return data

    def analyze(self, data=None, **kwargs):
        return enrichment.analyze(self.request() if data is None else data, store=self.store, runner=self.runner, **kwargs)

    def assert_pdf_unchanged(self):
        self.assertEqual(self.store._docs[self.pid]['pdf'], self.raw)
        self.assertEqual(sha256(self.store._docs[self.pid]['pdf']), self.digest)
        self.assertIn('ONE', page_text(self.store._docs[self.pid]['pdf']))
        self.assertIn('Groups', page_text(self.store._docs[self.pid]['pdf']))
        self.assertNotIn('SYNTH-OCR', page_text(self.store._docs[self.pid]['pdf']))


class AnalyzeTests(StoreCase):
    def test_results_bind_source_hash_image_and_mapped_boxes(self):
        self.assertEqual(self.summary['pageCount'], 1)
        before_items = self.store.list_items(self.pid)
        self.assertGreaterEqual(before_items['total'], 1)
        native = self.store.read_item(self.pid, before_items['items'][0]['id'])
        self.assertIn('Groups', json.dumps(native))
        ocr = self.analyze(self.request(bbox=OCR_BOX))
        chart = self.analyze(self.request(kind='chart', bbox=OCR_BOX))
        self.assertEqual([call['kind'] for call in self.runner.calls], ['ocr', 'chart'])
        self.assertEqual([call['language'] for call in self.runner.calls], ['en', 'en'])
        self.assertNotEqual(ocr['analysisId'], chart['analysisId'])
        self.assertEqual(ocr['bbox'], chart['bbox'])
        for kind, entry, call in (('ocr', ocr, self.runner.calls[0]), ('chart', chart, self.runner.calls[1])):
            self.assertEqual(entry['paperId'], self.pid)
            self.assertEqual(entry['fileHash'], self.digest)
            self.assertEqual(entry['kind'], kind)
            self.assertEqual(entry['pageIndex'], 0)
            self.assertEqual(set(entry['inputImage']), {'sha256', 'width', 'height', 'dpi'})
            self.assertEqual(entry['inputImage']['sha256'], call['sha256'])
            self.assertEqual((entry['inputImage']['width'], entry['inputImage']['height']), (call['width'], call['height']))
            self.assertNotIn('iVBOR', json.dumps(entry))
            self.assertIsInstance(entry['elapsedMs'], int)
            self.assertGreaterEqual(entry['elapsedMs'], 0)
        self.assertEqual(ocr['inputImage']['dpi'], 200)
        self.assertEqual(chart['inputImage']['dpi'], 150)
        self.assertNotEqual(ocr['inputImage']['sha256'], chart['inputImage']['sha256'])
        self.assertNotEqual(ocr['inputImage']['width'], chart['inputImage']['width'])
        width, height = ocr['inputImage']['width'], ocr['inputImage']['height']
        full, outside = ocr['data']['lines']
        self.assertEqual(full['text'], 'SYNTH-OCR')
        self.assertEqual(full['confidence'], 0.5)
        self.assertEqual(full['bbox'], [0, 0, width, height])
        self.assertEqual(full['sourceBbox'], source_box(ocr['bbox'], full['bbox'], width, height))
        self.assertEqual(full['sourceBbox'], [round(value, 4) for value in ocr['bbox']])
        self.assertEqual(outside['bbox'], [-2, 0, 4, 4])
        self.assertIsNone(outside['sourceBbox'])
        half = [0, 0, width / 2, height / 2]
        table = ocr['data']['tables'][0]
        self.assertEqual(table['sourceBbox'], source_box(ocr['bbox'], half, width, height))
        self.assertEqual(table['cells'][0]['sourceBbox'], table['sourceBbox'])
        self.assertEqual(table['cells'][0]['bbox'], half)
        numeric = chart['data']['numericCells'][0]
        self.assertEqual(numeric['value'], 1.5)
        self.assertEqual(numeric['raw'], '1.5')
        self.assertEqual(numeric['origin'], 'model-estimate')
        self.assertNotIn('sourceBbox', numeric)
        self.assertEqual(chart['data']['tables'][0]['sourceBbox'], [round(value, 4) for value in chart['bbox']])
        self.assertEqual(chart['data']['status'], 'partial')
        listed = self.store.list_analyses(self.pid)
        self.assertEqual(listed['fileHash'], self.digest)
        self.assertEqual(len(listed['items']), 2)
        self.assertNotIn('SYNTH-OCR', json.dumps(listed))
        self.assertNotIn('Groups', json.dumps(listed))
        self.assertEqual({item['kind'] for item in listed['items']}, {'ocr', 'chart'})
        stored = self.store.read_analysis(self.pid, ocr['analysisId'])
        self.assertEqual(stored['data']['lines'][0]['text'], 'SYNTH-OCR')
        ocr['data']['lines'][0]['text'] = 'MUTATED'
        self.assertEqual(self.store.read_analysis(self.pid, ocr['analysisId'])['data']['lines'][0]['text'], 'SYNTH-OCR')
        fresh_native = self.store.read_item(self.pid, native['id'])
        self.assertEqual(fresh_native, native)
        self.assertNotIn('SYNTH-OCR', json.dumps(fresh_native))
        self.assertNotIn('model-estimate', json.dumps(fresh_native))
        self.assertEqual(self.store.list_items(self.pid), before_items)
        other_raw = synthetic_pdf('TWO')
        other = self.store.prepare(other_raw, sha256(other_raw))
        self.assertEqual(self.store.list_analyses(other['paperId'])['items'], [])
        self.assertEqual(self.store.list_analyses(self.pid)['fileHash'], self.digest)
        self.assert_pdf_unchanged()
        cached = self.analyze(self.request(bbox=OCR_BOX, requestId='ab' * 16))
        self.assertEqual(cached['analysisId'], ocr['analysisId'])
        self.assertEqual(len(self.runner.calls), 2)
        cancelled = threading.Event()
        cancelled.set()
        still = self.analyze(self.request(bbox=OCR_BOX), cancelled=cancelled)
        self.assertEqual(still['analysisId'], ocr['analysisId'])
        self.assertEqual(len(self.runner.calls), 2)

    def test_language_bbox_and_request_id_share_one_fingerprint(self):
        first = self.analyze(self.request())
        second = self.analyze(self.request(bbox=None, language='en', requestId='cd' * 16))
        self.assertEqual(first['analysisId'], second['analysisId'])
        self.assertEqual(len(self.runner.calls), 1)
        korean = self.analyze(self.request(language='ko'))
        self.assertNotEqual(korean['analysisId'], first['analysisId'])
        self.assertEqual(korean['language'], 'ko')
        self.assertEqual(self.runner.calls[-1]['language'], 'ko')
        self.assertEqual(len(self.runner.calls), 2)
        self.assert_pdf_unchanged()

    def test_chart_engine_revision_cannot_reuse_a_previous_geometry_result(self):
        request = self.request(kind='chart', bbox=CHART_BOX)
        with patch.dict(enrichment.MODEL_REVISIONS, {'chart': 'previous-geometry'}):
            previous = self.analyze(request)
        current = self.analyze(request)
        self.assertNotEqual(previous['analysisId'], current['analysisId'])
        self.assertEqual(len(self.runner.calls), 2)
        self.assertEqual(self.analyze(request)['analysisId'], current['analysisId'])
        self.assertEqual(len(self.runner.calls), 2)

    def test_rejections_do_not_render_or_call_the_runner(self):
        def explode(*_args, **_kwargs):
            raise AssertionError('render')

        self.store.render_for_analysis = explode
        cases = [
            ('hash', self.request(fileHash='ab' * 32), 'analysis_hash_mismatch'),
            ('page', self.request(pageIndex=3), 'analysis_page_invalid'),
            ('kind', self.request(kind='figure'), 'analysis_request_invalid'),
            ('extra', self.request(pdfPath='C:/secret.pdf'), 'analysis_request_invalid'),
            ('language', self.request(language='ja'), 'analysis_language_invalid'),
            ('bbox', self.request(bbox=[0, 0, 0, 1]), 'analysis_region_invalid'),
            ('bool-bbox', self.request(bbox=[0, 0, True, 2]), 'analysis_region_invalid'),
            ('bool-page', self.request(pageIndex=True), 'analysis_request_invalid'),
            ('request-id', self.request(requestId='GG' * 16), 'analysis_request_id_invalid'),
            ('missing', self.request(paperId='missing-paper'), 'paper_evidence_expired_or_missing'),
        ]
        for name, data, code in cases:
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as caught:
                    enrichment.analyze(data, store=self.store, runner=self.runner)
                self.assertEqual(caught.exception.args[0], code)
        with self.assertRaises(ValueError) as caught:
            enrichment.analyze(self.request(paperId=''), store=self.store, runner=self.runner)
        self.assertRegex(str(caught.exception), r'^[A-Za-z0-9_]{1,80}$')
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(ValueError) as caught:
            enrichment.analyze(self.request(), store=self.store, runner=self.runner, cancelled=cancelled)
        self.assertEqual(caught.exception.args[0], 'analysis_cancelled')
        self.assertEqual(self.runner.calls, [])
        self.assert_pdf_unchanged()

    def test_expired_paper_is_rejected_before_the_runner(self):
        self.clock.t += 3601
        with self.assertRaises(ValueError) as caught:
            self.analyze()
        self.assertEqual(caught.exception.args[0], 'paper_evidence_expired_or_missing')
        self.assertEqual(self.runner.calls, [])

    def test_bad_engine_output_is_not_stored(self):
        before = self.store._docs[self.pid]['pdf']
        cases = [('mismatch', 'analysis_image_mismatch'), ('bad-size', 'analysis_image_mismatch'),
                 ('unavailable', 'analysis_engine_unavailable'), ('invalid', 'analysis_output_invalid'),
                 ('raise', 'analysis_worker_failed')]
        for mode, code in cases:
            self.runner.mode = mode
            with self.subTest(mode=mode):
                with self.assertRaises(ValueError) as caught:
                    self.analyze(self.request(bbox=OCR_BOX))
                self.assertEqual(caught.exception.args[0], code)
                self.assertEqual(self.store.list_analyses(self.pid)['items'], [])
                self.assertEqual(self.store._docs[self.pid]['pdf'], before)
        self.runner.mode = 'crash'
        with self.assertRaises(RuntimeError):
            self.analyze(self.request(bbox=OCR_BOX))
        self.assertEqual(self.store.list_analyses(self.pid)['items'], [])
        self.assertEqual(self.store._docs[self.pid]['pdf'], before)
        self.assertNotIn('SYNTH-OCR', page_text(before))


class JobTests(StoreCase):
    def submit(self, jobs, slot, data):
        return jobs.submit(data, admit=slot.admit, release=slot.release)

    def test_request_id_replay_and_alias_do_not_admit_twice(self):
        slot = ActiveSlot()
        jobs = enrichment.AnalysisJobs(self.store, self.runner)
        explicit = 'c' * 32
        first = self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId=explicit))
        self.assertEqual(first['id'], explicit)
        done = wait_job(jobs, explicit)
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(done['result']['fileHash'], self.digest)
        self.assertEqual(done['result']['inputImage']['sha256'], self.runner.calls[0]['sha256'])
        json.dumps(done, allow_nan=False)
        replay = self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId=explicit))
        self.assertEqual(replay['id'], explicit)
        self.assertEqual(replay['result']['analysisId'], done['result']['analysisId'])
        self.assertEqual(slot.acquires, 1)
        self.assertEqual(len(self.runner.calls), 1)
        generated = self.submit(jobs, slot, self.request(bbox=CHART_BOX))
        self.assertRegex(generated['id'], r'^[a-f0-9]{32}$')
        finished = wait_job(jobs, generated['id'])
        self.assertEqual(finished['state'], 'completed')
        alias = self.submit(jobs, slot, self.request(bbox=CHART_BOX))
        self.assertNotEqual(alias['id'], generated['id'])
        self.assertEqual(alias['state'], 'completed')
        self.assertEqual(alias['result']['analysisId'], finished['result']['analysisId'])
        self.assertEqual(slot.acquires, 2)
        self.assertEqual(slot.releases, 2)
        self.assertEqual(len(self.runner.calls), 2)
        self.assertFalse(slot.busy())
        self.assert_pdf_unchanged()

    def test_cancel_conflict_and_busy_share_one_slot(self):
        slot = ActiveSlot()
        jobs = enrichment.AnalysisJobs(self.store, self.runner)
        self.runner.stop_on_cancel = True
        first_id, alias_id = 'a' * 32, 'b' * 32
        running = self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId=first_id))
        self.assertEqual(running['state'], 'running')
        deadline = time.monotonic() + 5
        while not self.runner.calls and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(self.runner.calls), 1)
        json.dumps(running, allow_nan=False)
        same = self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId=first_id))
        alias = self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId=alias_id))
        self.assertEqual(same['id'], first_id)
        self.assertEqual(alias['id'], alias_id)
        self.assertEqual(alias['state'], 'running')
        self.assertEqual(slot.acquires, 1)
        self.assertEqual(len(self.runner.calls), 1)
        with self.assertRaises(ValueError) as conflict:
            self.submit(jobs, slot, self.request(bbox=CHART_BOX, requestId=first_id))
        self.assertEqual(conflict.exception.args[0], 'analysis_request_id_conflict')
        with self.assertRaises(ValueError) as busy:
            self.submit(jobs, slot, self.request(bbox=CHART_BOX, requestId='d' * 32))
        self.assertEqual(busy.exception.args[0], 'companion_busy')
        self.assertEqual(slot.acquires, 1)
        self.assertEqual(len(self.runner.calls), 1)
        jobs.cancel(alias_id)
        cancelled = wait_job(jobs, first_id)
        echoed = wait_job(jobs, alias_id)
        self.assertEqual(cancelled['state'], 'cancelled')
        self.assertEqual(cancelled['error'], 'analysis_cancelled')
        self.assertEqual(echoed['state'], 'cancelled')
        self.assertEqual(self.store.list_analyses(self.pid)['items'], [])
        self.assertEqual(slot.acquires, slot.releases)
        self.assertFalse(slot.busy())
        self.runner.stop_on_cancel = False
        started = self.submit(jobs, slot, self.request(bbox=CHART_BOX, requestId='d' * 32))
        done = wait_job(jobs, started['id'])
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(len(self.store.list_analyses(self.pid)['items']), 1)
        self.assertEqual(slot.acquires, 2)
        self.assertEqual(slot.releases, 2)
        self.assert_pdf_unchanged()

    def test_failed_job_releases_the_slot_and_hides_unsafe_text(self):
        slot = ActiveSlot()
        jobs = enrichment.AnalysisJobs(self.store, self.runner)
        self.runner.mode = 'raise'
        self.runner.error = 'analysis_worker_failed'
        failed = wait_job(jobs, self.submit(jobs, slot, self.request(bbox=OCR_BOX, requestId='e' * 32))['id'])
        self.assertEqual((failed['state'], failed['error']), ('failed', 'analysis_worker_failed'))
        self.runner.error = 'nope!'
        hidden = wait_job(jobs, self.submit(jobs, slot, self.request(bbox=CHART_BOX, requestId='f' * 32))['id'])
        self.assertEqual(hidden['error'], 'analysis_failed')
        self.runner.mode = 'crash'
        crashed = wait_job(jobs, self.submit(jobs, slot, self.request(bbox=[20, 20, 80, 80], requestId='1' * 32))['id'])
        self.assertEqual(crashed['error'], 'analysis_failed')
        self.assertEqual(slot.acquires, slot.releases)
        self.assertFalse(slot.busy())
        self.assertEqual(self.store.list_analyses(self.pid)['items'], [])
        self.assert_pdf_unchanged()

    def test_invalid_request_does_not_admit_and_unknown_job_is_missing(self):
        slot = ActiveSlot()
        jobs = enrichment.AnalysisJobs(self.store, self.runner)
        with self.assertRaises(ValueError) as caught:
            self.submit(jobs, slot, self.request(language='ja', requestId='a' * 32))
        self.assertEqual(caught.exception.args[0], 'analysis_language_invalid')
        self.assertEqual(slot.acquires, 0)
        self.assertEqual(self.runner.calls, [])
        self.assertTrue(slot._slot.acquire(blocking=False))
        try:
            with self.assertRaises(ValueError) as caught:
                self.submit(jobs, slot, self.request(requestId='b' * 32, bbox=OCR_BOX))
            self.assertEqual(caught.exception.args[0], 'companion_busy')
            with self.assertRaises(ValueError) as invalid:
                self.submit(jobs, slot, self.request(kind='nope', requestId='c' * 32))
            self.assertEqual(invalid.exception.args[0], 'analysis_request_invalid')
        finally:
            slot._slot.release()
        self.assertEqual(slot.acquires, 0)
        self.assertEqual(self.runner.calls, [])
        for method in (jobs.get, jobs.cancel):
            with self.assertRaises(ValueError) as missing:
                method('d' * 32)
            self.assertEqual(missing.exception.args[0], 'analysis_job_missing')

    def test_job_cap_keeps_replay_and_rejects_a_new_fingerprint(self):
        releases = []
        jobs = enrichment.AnalysisJobs(self.store, self.runner)

        def admit():
            return True

        def release():
            releases.append(1)

        first = None
        for index in range(32):
            data = self.request(bbox=[10, 10, 30 + index, 40], requestId=f'{index:032x}')
            receipt = jobs.submit(data, admit=admit, release=release)
            if first is None:
                first = data
            self.assertEqual(receipt['state'], 'running')
        with self.assertRaises(ValueError) as caught:
            jobs.submit(self.request(bbox=[10, 10, 90, 50], requestId='f' * 32), admit=admit, release=release)
        self.assertEqual(caught.exception.args[0], 'analysis_job_limit')
        replay = jobs.submit(first, admit=admit, release=release)
        self.assertEqual(replay['id'], first['requestId'])
        alias = dict(first)
        alias['requestId'] = 'e' * 32
        with self.assertRaises(ValueError) as caught:
            jobs.submit(alias, admit=admit, release=release)
        self.assertEqual(caught.exception.args[0], 'analysis_job_limit')
        for index in range(32):
            self.assertNotEqual(wait_job(jobs, f'{index:032x}', timeout=30)['state'], 'running')
        self.assertEqual(len(releases), 32)
        self.assert_pdf_unchanged()


class BlueTests(StoreCase):
    def test_curve_context_keeps_all_points_without_duplicating_numeric_cells(self):
        import paper_chart

        # Two same-color series: the redundant per-cell copy alone takes the
        # result over BLUE's budget, although its complete curve data fits.
        points = [{'xPixel': i + 10, 'yPixel': 20 + series * 30,
                   'x': i / 10, 'y': 10 - series * 3,
                   'pixelInterval': [9.8 - series * 3, 10.2 - series * 3],
                   'valueCandidates': {'left': 10 - series * 3},
                   'sourcePoint': [72 + i / 2, 100 + series * 15]}
                  for series in range(2) for i in range(30)]
        geometry = {'schema': 'falsify.chart-geometry.v1', 'status': 'ready', 'issues': [],
                    'axes': {'x': {'scale': 'linear'}, 'left': {'scale': 'linear'}},
                    'series': [{'id': f'series-{index + 1}', 'color': '#1f77b4', 'axisBinding': 'left',
                                'points': points[index * 30:(index + 1) * 30]}
                               for index in range(2)]}
        data = paper_chart._geometry_result(geometry, {'sha256': 'c' * 64, 'width': 200, 'height': 100})
        result = {'paperId': self.pid, 'fileHash': self.digest, 'kind': 'chart', 'pageIndex': 0,
                  'bbox': OCR_BOX, 'inputImage': {'sha256': 'c' * 64, 'width': 200, 'height': 100}, 'data': data}
        stored = self.store.add_analysis(self.pid, result, 'same-color-context')
        self.assertGreater(len(json.dumps(stored, separators=(',', ':'))), 24000)
        packed = blue.context_for_review(self.pid, self.digest, store=self.store)
        self.assertEqual(packed['coverage']['analyses']['omitted'], [])
        self.assertLessEqual(len(packed['text']), 24000)
        encoded = next(line for line in packed['text'].splitlines() if line.startswith('{"paperId"'))
        projection = json.loads(encoded)
        self.assertEqual(projection['data']['schema'], 'falsify.chart-context.v1')
        self.assertEqual(projection['data']['sourceSchema'], 'falsify.chart-data.v1')
        self.assertNotIn('numericCells', projection['data'])
        self.assertEqual(projection['data']['geometry'], geometry)
        self.assertEqual(projection['data']['rows'], data['rows'])
        self.assertEqual({row[0] for row in projection['data']['rows']}, {'series-1', 'series-2'})
        self.assertEqual(projection['data']['provenance'], data['provenance'])
        self.assertEqual(packed['coverage']['analyses']['included'][0]['representation'],
                         'table-and-original-curve-points')
        self.assertEqual(self.store.read_analysis(self.pid, stored['analysisId']), stored)
        self.assertEqual(stored['data']['numericCells'], data['numericCells'])
        self.assert_pdf_unchanged()

    def test_plottracer_context_keeps_rows_and_source_binding_without_duplicate_geometry(self):
        import paper_chart
        geometry = {'schema': 'falsify.chart-geometry.v1', 'status': 'ready', 'issues': [],
                    'axes': {'x': {'scale': 'linear'}, 'left': {'scale': 'linear'}},
                    'provenance': {'engine': 'plottracer', 'revision': 'dcc28a5'},
                    'series': [{'id': 'series-1', 'color': '#123456', 'axisBinding': 'left',
                                'pointKind': 'curve-sample', 'points': [{'xPixel': 10, 'yPixel': 20, 'x': 1, 'y': -2,
                                'pixelInterval': [-2.1, -1.9], 'sourcePoint': [72, 100]}]}]}
        data = paper_chart._geometry_result(geometry, {'sha256': 'c' * 64, 'width': 200, 'height': 100})
        data['provenance']['method'] = 'oss-pixel-calibration'
        stored = self.store.add_analysis(self.pid, {'paperId': self.pid, 'fileHash': self.digest,
            'kind': 'chart', 'pageIndex': 0, 'bbox': OCR_BOX,
            'inputImage': {'sha256': 'c' * 64, 'width': 200, 'height': 100}, 'data': data}, 'oss-context')
        packed = blue.context_for_review(self.pid, self.digest, store=self.store)
        self.assertIn('Samples are not independent observations', packed['text'])
        projection = json.loads(next(line for line in packed['text'].splitlines() if line.startswith('{"paperId"')))
        self.assertEqual(projection['data']['rows'], data['rows'])
        self.assertEqual(projection['data']['curveSources'][0]['color'], '#123456')
        self.assertEqual(projection['data']['representation'], 'table-and-geometry-summary')
        self.assertNotIn('numericCells', projection['data'])
        self.assertNotIn('geometry', projection['data'])
        self.assertEqual(self.store.read_analysis(self.pid, stored['analysisId']), stored)

    def test_derived_ocr_and_chart_are_labeled_and_can_be_omitted(self):
        ocr = self.analyze(self.request(bbox=OCR_BOX))
        chart = self.analyze(self.request(kind='chart', bbox=CHART_BOX))
        packed = blue.context_for_review(self.pid, self.digest, store=self.store)
        text = packed['text']
        self.assertIn('Groups', text)
        self.assertIn('DERIVED OCR transcription; may contain recognition errors; confidence is engine-reported.', text)
        self.assertIn('DERIVED chart table; numeric values are model estimates, not measured source data.', text)
        self.assertLess(text.index('Groups'), text.index('DERIVED OCR'))
        self.assertLess(text.index('DERIVED OCR'), text.index('DERIVED chart'))
        self.assertIn('"origin":"model-estimate"', text.replace(' ', ''))
        self.assertIn('SYNTH-OCR', text)
        self.assertNotIn('iVBOR', text)
        coverage = packed['coverage']
        self.assertEqual(coverage['fileHash'], self.digest)
        self.assertEqual(coverage['paperId'], self.pid)
        analyses = coverage['analyses']
        self.assertEqual(analyses['available'], 2)
        self.assertEqual(analyses['omitted'], [])
        self.assertEqual(sorted(item['kind'] for item in analyses['included']), ['chart', 'ocr'])
        included = {item['kind']: item for item in analyses['included']}
        self.assertEqual(included['ocr']['imageSha256'], ocr['inputImage']['sha256'])
        self.assertEqual(included['chart']['imageSha256'], chart['inputImage']['sha256'])
        self.assertEqual(included['chart']['analysisId'], chart['analysisId'])
        self.assertEqual(coverage['other']['included'], 2)
        tiny = blue.context_for_review(self.pid, self.digest, store=self.store, max_chars=0)
        self.assertNotIn('SYNTH-OCR', tiny['text'])
        self.assertNotIn('model-estimate', tiny['text'])
        self.assertEqual(tiny['coverage']['analyses']['included'], [])
        self.assertEqual(sorted(tiny['coverage']['analyses']['omitted']), sorted([ocr['analysisId'], chart['analysisId']]))
        self.assertGreater(tiny['coverage']['truncationCount'], 0)
        self.assertEqual(tiny['coverage']['fileHash'], self.digest)
        with self.assertRaises(ValueError) as mismatch:
            blue.context_for_review(self.pid, 'ab' * 32, store=self.store)
        self.assertEqual(mismatch.exception.args[0], 'paper_evidence_hash_mismatch')
        with self.assertRaises(ValueError) as missing:
            blue.context_for_review('missing-paper', self.digest, store=self.store)
        self.assertEqual(missing.exception.args[0], 'paper_evidence_unknown_id')
        self.assert_pdf_unchanged()


class DigitizerTests(StoreCase):
    def test_calibration_binds_one_render_and_leaves_the_pdf_unchanged(self):
        import paper_digitizer

        image = self.store.render_region(self.pid, 0, OCR_BOX, dpi=120)
        width, height = image['width'], image['height']
        before_items = self.store.list_items(self.pid)
        linear = {'x': {'scale': 'linear', 'points': [{'pixel': 0, 'value': 0}, {'pixel': width, 'value': 10}]},
                  'y': {'scale': 'linear', 'points': [{'pixel': 0, 'value': 0}, {'pixel': height, 'value': 100}]}}
        point = [width / 2, height / 2]
        entry = paper_digitizer.digitize(self.store, self.pid, self.digest, 0, image['sha256'], linear, [point], bbox=OCR_BOX, dpi=120)
        again = paper_digitizer.digitize(self.store, self.pid, self.digest, 0, image['sha256'], linear, [point], bbox=OCR_BOX, dpi=120)
        self.assertEqual(again['analysisId'], entry['analysisId'])
        self.assertEqual(len(self.store.list_analyses(self.pid)['items']), 1)
        self.assertEqual(entry['kind'], 'chart')
        self.assertEqual(entry['fileHash'], self.digest)
        self.assertEqual(entry['inputImage']['sha256'], image['sha256'])
        self.assertEqual(entry['inputImage']['dpi'], 120)
        cells = entry['data']['numericCells']
        self.assertEqual([cell['origin'] for cell in cells], ['pixel-calibrated', 'pixel-calibrated'])
        self.assertAlmostEqual(cells[0]['value'], 5)
        self.assertAlmostEqual(cells[1]['value'], 50)
        self.assertEqual(entry['data']['provenance']['model'], None)
        self.assertEqual(entry['data']['sourcePoints'], [[
            image['bbox'][0] + point[0] / width * (image['bbox'][2] - image['bbox'][0]),
            image['bbox'][1] + point[1] / height * (image['bbox'][3] - image['bbox'][1])]])
        logged = {'x': {'scale': 'log', 'points': [{'pixel': 0, 'value': 1}, {'pixel': width, 'value': 100}]},
                  'y': {'scale': 'linear', 'points': [{'pixel': 0, 'value': 0}, {'pixel': height, 'value': 10}]}}
        log_entry = paper_digitizer.digitize(self.store, self.pid, self.digest, 0, image['sha256'], logged, [point], bbox=OCR_BOX, dpi=120)
        self.assertAlmostEqual(log_entry['data']['numericCells'][0]['value'], 10)
        self.assertNotEqual(log_entry['analysisId'], entry['analysisId'])
        with self.assertRaises(ValueError) as mismatch:
            paper_digitizer.digitize(self.store, self.pid, self.digest, 0, '0' * 64, linear, [point], bbox=OCR_BOX, dpi=120)
        self.assertEqual(mismatch.exception.args[0], 'digitizer_image_mismatch')
        with self.assertRaises(ValueError) as wrong_hash:
            paper_digitizer.digitize(self.store, self.pid, 'ab' * 32, 0, image['sha256'], linear, [point], bbox=OCR_BOX, dpi=120)
        self.assertEqual(wrong_hash.exception.args[0], 'analysis_hash_mismatch')
        self.assertEqual(len(self.store.list_analyses(self.pid)['items']), 2)
        self.assertEqual(self.store.list_items(self.pid), before_items)
        packed = blue.context_for_review(self.pid, self.digest, store=self.store)
        self.assertIn('caller-selected axis ticks and image points, pixel-calibrated estimates, not measured source data.', packed['text'])
        self.assertNotIn('numeric values are model estimates', packed['text'])
        self.assertIn('pixel-calibrated', packed['text'])
        self.assertEqual(packed['coverage']['analyses']['available'], 2)
        self.assertEqual({item['kind'] for item in packed['coverage']['analyses']['included']}, {'chart'})
        self.assert_pdf_unchanged()


class McpTests(StoreCase):
    def test_help_and_analysis_registration(self):
        stdout = __import__('io').StringIO()
        with patch('sys.stdout', stdout):
            code = paper_mcp.main(['--help'])
        self.assertEqual(code, 0)
        self.assertIn('--pdf', stdout.getvalue())
        self.assertIn('--analysis', stdout.getvalue())
        with patch('paper_enrichment.run_child', side_effect=AssertionError('model process')):
            plain = paper_mcp.build_server(self.store, self.pid, self.digest, enable_analysis=False)
            full = paper_mcp.build_server(self.store, self.pid, self.digest, enable_analysis=True)
            plain_tools = anyio.run(plain.list_tools)
            tools = anyio.run(full.list_tools)
        self.assertEqual({tool.name for tool in plain_tools}, BASE_TOOLS)
        self.assertEqual({tool.name for tool in tools}, BASE_TOOLS | ANALYSIS_TOOLS)
        by_name = {}
        for tool in tools:
            by_name[tool.name] = tool
            self.assertTrue(tool.annotations.readOnlyHint)
            self.assertFalse(tool.annotations.destructiveHint)
            self.assertFalse(tool.annotations.openWorldHint)
            self.assertTrue(tool.annotations.idempotentHint)
            props = set((tool.inputSchema or {}).get('properties') or {})
            self.assertTrue(props.isdisjoint({'path', 'file', 'url', 'pdf', 'fileHash', 'filePath'}))
        self.assertIn('transcription', by_name['ocr_page'].description)
        self.assertIn('estimates', by_name['extract_chart'].description)
        self.assertIn('does not infer ticks', by_name['digitize_points'].description)
        self.assertEqual(self.runner.calls, [])

    def test_stdio_analysis_tools_bind_the_selected_pdf(self):
        parent = evidence.EvidenceStore(ttl_seconds=3600, clock=Clock())
        prepared = parent.prepare(self.raw, self.digest)
        ocr_image = parent.render_for_analysis(prepared['paperId'], 0, OCR_BOX, dpi=200)
        chart_image = parent.render_for_analysis(prepared['paperId'], 0, CHART_BOX, dpi=150)
        preview = parent.render_region(prepared['paperId'], 0, OCR_BOX, dpi=120)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            pdf = folder / 'selected.pdf'
            pdf.write_bytes(self.raw)
            secret = folder / 'secret.txt'
            secret.write_text(SENTINEL, encoding='utf-8')
            flag = folder / 'runner.json'
            (folder / 'analysis_stdio.py').write_text(CHILD, encoding='utf-8')
            err_path = folder / 'stderr.txt'

            async def run():
                params = StdioServerParameters(
                    command=sys.executable,
                    args=[str(folder / 'analysis_stdio.py'), str(LOCAL), str(pdf), str(flag)],
                    cwd=folder,
                    env={'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
                with err_path.open('w', encoding='utf-8') as err:
                    with anyio.fail_after(45):
                        async with stdio_client(params, errlog=err) as (read, write):
                            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=20)) as session:
                                init = await session.initialize()
                                self.assertEqual(init.serverInfo.name, paper_mcp.SERVER_NAME)
                                binding = json.loads(init.instructions.split('Selected PDF: ', 1)[1])
                                self.assertEqual(binding['fileHash'], self.digest)
                                self.assertNotIn(SENTINEL, init.instructions or '')
                                names = {tool.name for tool in (await session.list_tools()).tools}
                                self.assertEqual(names, BASE_TOOLS | ANALYSIS_TOOLS)
                                status = await session.call_tool('status', {'paperId': binding['paperId']})
                                self.assertFalse(status.isError)
                                self.assertEqual(status.structuredContent['fileHash'], self.digest)
                                listed = await session.call_tool('list_items', {'paperId': binding['paperId']})
                                self.assertFalse(listed.isError)
                                self.assertGreaterEqual(listed.structuredContent['total'], 1)
                                item = await session.call_tool('read_item', {'paperId': binding['paperId'], 'itemId': listed.structuredContent['items'][0]['id']})
                                self.assertFalse(item.isError)
                                self.assertIn('Groups', json.dumps(item.structuredContent))
                                self.assertNotIn('SYNTH-OCR', json.dumps(item.structuredContent))
                                rendered = await session.call_tool('render_region', {'paperId': binding['paperId'], 'pageIndex': 0, 'bbox': OCR_BOX, 'dpi': 120})
                                self.assertFalse(rendered.isError)
                                self.assertEqual(rendered.structuredContent['sha256'], preview['sha256'])
                                self.assertNotIn('data', rendered.structuredContent)
                                self.assertEqual(len([block for block in rendered.content if block.type == 'image']), 1)
                                width, height = rendered.structuredContent['width'], rendered.structuredContent['height']
                                calibration = {'x': {'scale': 'linear', 'points': [{'pixel': 0, 'value': 0}, {'pixel': width, 'value': 10}]},
                                               'y': {'scale': 'linear', 'points': [{'pixel': 0, 'value': 0}, {'pixel': height, 'value': 100}]}}
                                point = [width / 2, height / 2]
                                digitized = await session.call_tool('digitize_points', {'paperId': binding['paperId'], 'pageIndex': 0,
                                    'imageSha256': rendered.structuredContent['sha256'], 'calibration': calibration, 'points': [point],
                                    'bbox': OCR_BOX, 'dpi': 120})
                                self.assertFalse(digitized.isError, digitized.structuredContent)
                                self.assertEqual(digitized.structuredContent['fileHash'], self.digest)
                                self.assertEqual(digitized.structuredContent['inputImage']['sha256'], preview['sha256'])
                                self.assertEqual(digitized.structuredContent['data']['numericCells'][0]['origin'], 'pixel-calibrated')
                                self.assertAlmostEqual(digitized.structuredContent['data']['numericCells'][0]['value'], 5)
                                repeated = await session.call_tool('digitize_points', {'paperId': binding['paperId'], 'pageIndex': 0,
                                    'imageSha256': rendered.structuredContent['sha256'], 'calibration': calibration, 'points': [point],
                                    'bbox': OCR_BOX, 'dpi': 120})
                                self.assertEqual(repeated.structuredContent['analysisId'], digitized.structuredContent['analysisId'])
                                mismatched = await session.call_tool('digitize_points', {'paperId': binding['paperId'], 'pageIndex': 0,
                                    'imageSha256': '0' * 64, 'calibration': calibration, 'points': [point], 'bbox': OCR_BOX, 'dpi': 120})
                                self.assertTrue(mismatched.isError)
                                self.assertEqual(mismatched.structuredContent['error'], 'digitizer_image_mismatch')
                                empty = await session.call_tool('list_analyses', {'paperId': binding['paperId']})
                                self.assertEqual(len(empty.structuredContent['items']), 1)
                                self.assertEqual(empty.structuredContent['items'][0]['kind'], 'chart')
                                self.assertNotIn('pixel-calibrated', json.dumps(empty.structuredContent))
                                decoy = await session.call_tool('ocr_page', {'paperId': 'other-paper', 'pageIndex': 0})
                                self.assertTrue(decoy.isError)
                                self.assertEqual(decoy.structuredContent['error'], 'paper_evidence_unknown_id')
                                self.assertNotIn(SENTINEL, json.dumps(decoy.model_dump(mode='json')))
                                ocr = await session.call_tool('ocr_page', {'paperId': binding['paperId'], 'pageIndex': 0, 'bbox': OCR_BOX, 'language': 'en'})
                                self.assertFalse(ocr.isError)
                                body = ocr.structuredContent
                                self.assertEqual(body['fileHash'], self.digest)
                                self.assertEqual(body['inputImage']['sha256'], ocr_image['sha256'])
                                self.assertEqual(body['inputImage']['dpi'], 200)
                                self.assertEqual(body['bbox'], ocr_image['bbox'])
                                self.assertEqual(body['data']['lines'][0]['text'], 'SYNTH-OCR')
                                self.assertEqual(body['data']['lines'][0]['sourceBbox'], [round(value, 4) for value in body['bbox']])
                                self.assertFalse(any(block.type == 'image' for block in ocr.content))
                                self.assertNotIn('iVBOR', json.dumps(body))
                                again = await session.call_tool('ocr_page', {'paperId': binding['paperId'], 'pageIndex': 0, 'bbox': OCR_BOX, 'language': 'en'})
                                self.assertEqual(again.structuredContent['analysisId'], body['analysisId'])
                                chart = await session.call_tool('extract_chart', {'paperId': binding['paperId'], 'pageIndex': 0, 'bbox': CHART_BOX})
                                self.assertFalse(chart.isError)
                                chart_body = chart.structuredContent
                                self.assertEqual(chart_body['fileHash'], self.digest)
                                self.assertEqual(chart_body['inputImage']['sha256'], chart_image['sha256'])
                                self.assertEqual(chart_body['inputImage']['dpi'], 150)
                                self.assertEqual(chart_body['data']['numericCells'][0]['origin'], 'model-estimate')
                                self.assertEqual(chart_body['data']['numericCells'][0]['value'], 1.5)
                                self.assertNotEqual(chart_body['analysisId'], body['analysisId'])
                                analyses = await session.call_tool('list_analyses', {'paperId': binding['paperId']})
                                self.assertEqual(sorted(item['kind'] for item in analyses.structuredContent['items']), ['chart', 'chart', 'ocr'])
                                self.assertNotIn('SYNTH-OCR', json.dumps(analyses.structuredContent))
                                read = await session.call_tool('read_analysis', {'paperId': binding['paperId'], 'analysisId': body['analysisId']})
                                self.assertEqual(read.structuredContent['data']['lines'][0]['text'], 'SYNTH-OCR')
                                missing = await session.call_tool('read_analysis', {'paperId': binding['paperId'], 'analysisId': 'a' + '0' * 24})
                                self.assertTrue(missing.isError)
                                self.assertEqual(missing.structuredContent['error'], 'paper_evidence_unknown_id')
                                rejected = await session.call_tool('ocr_page', {'paperId': binding['paperId'], 'pageIndex': 0, 'language': 'ja'})
                                self.assertTrue(rejected.isError)
                                self.assertEqual(rejected.structuredContent['error'], 'analysis_language_invalid')
                                bad_page = await session.call_tool('ocr_page', {'paperId': binding['paperId'], 'pageIndex': 5})
                                self.assertTrue(bad_page.isError)
                                self.assertEqual(bad_page.structuredContent['error'], 'analysis_page_invalid')
                                self.assertEqual(secret.read_text(encoding='utf-8'), SENTINEL)
                                self.assertEqual(pdf.read_bytes(), self.raw)

            try:
                anyio.run(run)
            except Exception as exc:
                err = err_path.read_text(encoding='utf-8', errors='replace') if err_path.exists() else ''
                raise AssertionError(f'{exc}\n--- stderr ---\n{err}') from exc
            self.assertEqual(pdf.read_bytes(), self.raw)
            report = json.loads(flag.read_text(encoding='utf-8'))
        self.assertEqual(report['calls'], [{'kind': 'ocr', 'language': 'en'}, {'kind': 'chart', 'language': 'en'}])
        self.assertEqual(report['heavy'], [])
        self.assertEqual(report['code'], 0)


class WorkerEncodingTests(unittest.TestCase):
    def test_worker_protocol_is_utf8_even_when_the_pipe_defaults_to_cp949(self):
        script = r'''
import base64, io, json, runpy, sys, types
sys.stdout.reconfigure(encoding='cp949')
sys.modules['paper_ocr'] = types.SimpleNamespace(recognize=lambda *a, **k: {'text': '\ud55c\uad6d\uc5b4 \uacb0\uacfc \u2212 7.8'})
sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps({'kind':'ocr', 'language':'ko', 'png':base64.b64encode(b'fixture').decode()}).encode()), encoding='utf-8')
sys.argv = [sys.argv[1], '--worker']
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        completed = subprocess.run([sys.executable, '-I', '-c', script, str(LOCAL / 'paper_enrichment.py')],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        result = json.loads(completed.stdout.decode('utf-8'))
        self.assertEqual(result, {'ok': True, 'data': {'text': '한국어 결과 − 7.8'}})


if __name__ == '__main__':
    unittest.main()
