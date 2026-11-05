"""Chart edit binding, identity, expiration and authenticated HTTP contract."""
import base64
import copy
import hashlib
import http.client
import json
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_evidence import EvidenceStore
from paper_chart_edit_service import ChartEditService, SCHEMA
import server


def source_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((20, 20), 'Original chart')
    page.draw_line((30, 170), (270, 30), color=(0, 0, 1))
    raw = doc.tobytes()
    doc.close()
    return raw


def fake_prepare(raw, index, bbox, options=None):
    return {'width': 300, 'height': 200, 'plotBbox': [0, 0, 300, 200],
            '_binding': {'operator': 42}, 'series': [{'id': 's1', 'color': '#0000ff',
            'style': {'width': 1}, 'points': [{'x': 30, 'y': 170}, {'x': 270, 'y': 30}]}]}


class ChartEditServiceTests(unittest.TestCase):
    def setUp(self):
        self.raw = source_pdf()
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.store = EvidenceStore()
        self.pid = self.store.prepare(self.raw, self.digest)['paperId']
        self.now = [0]
        self.svc = ChartEditService(self.store, ttl=5, max_scenes=2, clock=lambda: self.now[0])
        scene_module = types.SimpleNamespace(prepare_scene=fake_prepare)
        core_module = types.SimpleNamespace(evaluate=lambda scene, operations: copy.deepcopy(scene))
        paint_module = types.SimpleNamespace(export_scene=lambda raw, scene, edited: (raw, {'issues': []}))
        self.patches = patch.dict(sys.modules, {'paper_chart_scene': scene_module,
            'paper_chart_shape_core': core_module, 'paper_chart_paint': paint_module})
        self.patches.start()
        self.addCleanup(self.patches.stop)
        import paper_native_worker
        real_run = paper_native_worker.run
        def run(operation, args, **kwargs):
            if operation == 'chart_prepare': return fake_prepare(*args[:4])
            if operation == 'chart_export': return [args[0], {'issues': []}, 1, []]
            if operation == 'chart_evaluate': return copy.deepcopy(args[0])
            return real_run(operation, args, **kwargs)
        runner_patch = patch('paper_native_worker.run', side_effect=run)
        runner_patch.start()
        self.addCleanup(runner_patch.stop)

    def prepare(self):
        return self.svc.prepare({'paperId': self.pid, 'fileHash': self.digest,
                                 'pageIndex': 0, 'bbox': [0, 0, 300, 200]})

    def plan(self, scene):
        return {'schema': SCHEMA, 'paperId': self.pid, 'fileHash': self.digest,
                'sceneId': scene['sceneId'], 'revision': 1, 'operations': []}

    def test_private_source_binding_not_exposed(self):
        scene = self.prepare()
        self.assertNotIn('_binding', scene)
        self.assertIn('_binding', self.svc.scenes[scene['sceneId']]['scene'])

    def test_eviction_during_preparation_cannot_publish(self):
        started, release = threading.Event(), threading.Event()
        def delayed(operation, args, **kwargs):
            started.set()
            self.assertTrue(release.wait(10))
            return fake_prepare(*args[:4])
        errors = []
        def prepare():
            try: self.prepare()
            except Exception as exc: errors.append(exc)
        with patch('paper_native_worker.run', side_effect=delayed):
            thread = threading.Thread(target=prepare)
            thread.start()
            self.assertTrue(started.wait(10))
            with self.store._lock:
                self.store._drop(self.pid)
            release.set(); thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(str(errors[0]), 'chart_source_expired')
        self.assertFalse(self.svc.scenes)
        self.pid = self.store.prepare(self.raw, self.digest)['paperId']
        self.assertTrue(self.prepare()['sceneId'])

    def test_preparation_budget_includes_source_lookup(self):
        import time
        import paper_native_worker
        source = self.svc._source
        def delayed(*args):
            time.sleep(.05)
            return source(*args)
        with patch.object(paper_native_worker, 'TIMEOUT', .01), patch.object(self.svc, '_source', side_effect=delayed):
            with self.assertRaisesRegex(ValueError, 'native_timeout'): self.prepare()
        self.assertFalse(self.svc.scenes)

    def test_identity_export_preserves_original_bytes_and_no_changes(self):
        result = self.svc.export(self.plan(self.prepare()))
        self.assertEqual(base64.b64decode(result['file']), self.raw)
        self.assertEqual(result['sourceSha256'], result['outputSha256'])
        self.assertEqual(result['changes'], [])
        self.assertEqual(result['schema'], 'falsify.visual-edit-export.v1')

    def test_expired_scene_cannot_apply_to_source(self):
        plan = self.plan(self.prepare())
        self.now[0] = 6
        with self.assertRaisesRegex(ValueError, 'scene_expired'):
            self.svc.export(plan)

    def test_scene_cannot_cross_documents(self):
        scene = self.prepare()
        other = source_pdf()
        digest = hashlib.sha256(other).hexdigest()
        pid = self.store.prepare(other, digest)['paperId']
        plan = {**self.plan(scene), 'paperId': pid, 'fileHash': digest}
        with self.assertRaisesRegex(ValueError, 'source_mismatch'):
            self.svc.export(plan)

    def test_scene_budget_evicts_old_scene(self):
        first = self.prepare()
        self.now[0] += 1
        self.prepare()
        self.now[0] += 1
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'scene_expired'):
            self.svc.export(self.plan(first))

    def test_bad_revision_and_unknown_fields_rejected(self):
        plan = self.plan(self.prepare())
        for value in [True, -1, 1.2, '1']:
            with self.assertRaisesRegex(ValueError, 'revision_invalid'):
                self.svc.export({**plan, 'revision': value})
        with self.assertRaisesRegex(ValueError, 'plan_invalid'):
            self.svc.export({**plan, 'scene': {'operator': 42}})


class ChartHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def call(self, route, data, auth=True):
        headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.http.server_port}'}
        if auth:
            headers['Authorization'] = 'Bearer ' + server.TOKEN
        conn = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=10)
        conn.request('POST', route, json.dumps(data), headers)
        res = conn.getresponse()
        result = res.status, json.loads(res.read())
        conn.close()
        return result

    def test_routes_are_authenticated_and_callable(self):
        import paper_chart_edit_service
        for action in ('prepare', 'preview', 'export'):
            route = '/api/paper/chart/' + action
            self.assertTrue(server.cors_route('POST', route))
            self.assertFalse(server.cors_route('GET', route))
            self.assertEqual(self.call(route, {}, auth=False)[0], 403)
            with patch.object(paper_chart_edit_service.default_service, action, return_value={'accepted': action}):
                self.assertEqual(self.call(route, {}), (200, {'accepted': action}))
