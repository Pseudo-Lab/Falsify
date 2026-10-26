"""Companion instance descriptor and job GET binding. No model call and no process on port 7816."""
import hashlib
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
LOCAL = Path(__file__).resolve().parents[1] / 'local'
sys.path.insert(0, str(LOCAL))
import server
from harness import resolve

SECRET = 'launcher-instance-secret-not-a-descriptor'


def active_free():
    if not server.ACTIVE.acquire(blocking=False):
        return False
    server.ACTIVE.release()
    return True


class RecoveryServer(unittest.TestCase):
    def setUp(self):
        self.assertTrue(active_free())
        self.jobs = patch.dict(server.JOBS, clear=True)
        self.jobs.start()
        self.addCleanup(self.jobs.stop)
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.http.daemon_threads = True
        self.port = self.http.server_port
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        if self.thread.is_alive():
            self.http.shutdown()
        self.thread.join(5)
        self.http.server_close()
        self.assertTrue(active_free())

    def call(self, path):
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request('GET', path, headers={'Host': f'127.0.0.1:{self.port}', 'Authorization': 'Bearer ' + server.TOKEN, 'Sec-Fetch-Site': 'same-origin'})
            res = conn.getresponse()
            raw = res.read()
        finally:
            conn.close()
        data = json.loads(raw) if res.getheader('Content-Type', '').startswith('application/json') else raw
        return res.status, data

    def test_descriptor_hides_the_launcher_id(self):
        first = server.companion_instance_descriptor(SECRET)
        again = server.companion_instance_descriptor(SECRET)
        other = server.companion_instance_descriptor(SECRET + '-b')
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)
        self.assertRegex(first, r'^ci1\.[0-9a-f]{64}$')
        self.assertNotIn(SECRET, first)
        self.assertNotIn(self.http.instance_id, server.companion_instance_descriptor(self.http.instance_id))

    def test_capabilities_publish_the_descriptor_only(self):
        status, data = self.call('/api/capabilities')
        self.assertEqual(status, 200)
        descriptor = server.companion_instance_descriptor(self.http.instance_id)
        self.assertEqual(data['companionInstance'], descriptor)
        encoded = json.dumps(data)
        self.assertNotIn(self.http.instance_id, encoded)
        self.assertNotIn(server.TOKEN, encoded)

    def test_job_get_requires_binding_fields_and_omits_secrets(self):
        source = 'ab' * 32
        data = {'sourceHash': source, 'revision': 'rev-1'}
        _, harness_hash = resolve(data, 'red')
        binding = server.job_binding(data, 'red', self.http.instance_id)
        self.assertEqual(binding['harnessHash'], harness_hash)
        self.assertEqual(binding['sourceHash'], source)
        self.assertNotIn(self.http.instance_id, binding['companionInstance'])
        server.JOBS['rev-1:job'] = {
            'id': 'rev-1:job', 'role': 'red', 'state': 'running', 'progress': {'completedCalls': 0},
            'cancel': threading.Event(), 'fingerprint': '{"secret":"request"}', 'requestBytesDigest': 'ab' * 32,
            'created': time.monotonic(),
            **binding,
        }
        status, body = self.call('/api/red/jobs/rev-1:job')
        self.assertEqual(status, 200)
        self.assertEqual(body['id'], 'rev-1:job')
        self.assertEqual(body['role'], 'red')
        self.assertEqual(body['sourceHash'], source)
        self.assertEqual(body['revision'], 'rev-1')
        self.assertEqual(body['harnessHash'], harness_hash)
        self.assertEqual(body['companionInstance'], binding['companionInstance'])
        self.assertEqual(body['requestBytesDigest'], 'ab' * 32)
        self.assertNotIn('cancel', body)
        self.assertNotIn('fingerprint', body)
        self.assertNotIn('secret', json.dumps(body))
        self.assertNotIn(server.TOKEN, json.dumps(body))

    def test_running_jobs_survive_the_retention_sweep(self):
        now = time.monotonic()
        server.JOBS['running'] = {'id': 'running', 'role': 'red', 'state': 'running'}
        server.JOBS['fresh'] = {'id': 'fresh', 'role': 'blue', 'state': 'completed', 'finished': now - 10}
        server.JOBS['old'] = {'id': 'old', 'role': 'red', 'state': 'completed', 'finished': now - server.RESULT_RETENTION - 5}
        server.drop_expired_jobs(now)
        self.assertIn('running', server.JOBS)
        self.assertIn('fresh', server.JOBS)
        self.assertNotIn('old', server.JOBS)
        self.assertEqual(server.RESULT_RETENTION, 3600)

    def post(self, path, raw):
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request('POST', path, body=raw, headers={
                'Host': f'127.0.0.1:{self.port}',
                'Authorization': 'Bearer ' + server.TOKEN,
                'Origin': f'http://127.0.0.1:{self.port}',
                'Sec-Fetch-Site': 'same-origin',
                'Content-Type': 'application/json',
            })
            res = conn.getresponse()
            data = json.loads(res.read().decode())
        finally:
            conn.close()
        return res.status, data

    def test_get_echoes_raw_request_bytes_not_the_idempotency_fingerprint(self):
        js = '{"harness": {"settings": {"large": 100000000000000000000, "tiny": 1e-7, "😀": 1, "": 2}}, "requestId": "synthetic"}'
        py = '{"harness": {"settings": {"large": 1e+20, "tiny": 1e-07, "": 2, "😀": 1}}, "requestId": "synthetic"}'
        self.assertNotEqual(js, py)
        raw_js = js.encode('utf-8')
        wire = server.request_bytes_digest(raw_js)
        self.assertEqual(wire, hashlib.sha256(raw_js).hexdigest())
        idem = json.dumps(json.loads(raw_js.decode('utf-8')), sort_keys=True, ensure_ascii=False)
        self.assertNotEqual(idem, js)
        self.assertNotEqual(hashlib.sha256(idem.encode('utf-8')).hexdigest(), wire)
        text = 'Synthetic recovery source.'
        source = hashlib.sha256(text.encode()).hexdigest()
        first = ('{"schema":"falsify.document-red.v1","revision":"r1","requestId":"rev-bytes-1",'
                 f'"sourceHash":"{source}","segments":[{{"id":"s0","label":"p","text":"{text}"}}],'
                 '"level":1,"maxCalls":1,"consent":true}').encode()
        changed = first.replace(b'"level":1,"maxCalls":1', b'"level":3,"maxCalls":8')
        self.assertNotEqual(server.request_bytes_digest(first), server.request_bytes_digest(changed))
        done = threading.Event()

        def fake(data, progress, cancel):
            done.set()
            return {'status': 'abstain', 'candidates': []}

        with patch.object(server, 'run_review', fake):
            status, body = self.post('/api/red/jobs', first)
            self.assertEqual(status, 202, body)
            self.assertTrue(done.wait(2))
            for _ in range(50):
                if active_free():
                    break
                time.sleep(0.01)
            self.assertTrue(active_free())
            got, job = self.call('/api/red/jobs/rev-bytes-1')
            self.assertEqual(got, 200)
            self.assertEqual(job['requestBytesDigest'], hashlib.sha256(first).hexdigest())
            self.assertNotIn('fingerprint', job)
            self.assertEqual(server.JOBS['rev-bytes-1']['fingerprint'], json.dumps(json.loads(first.decode()), sort_keys=True, ensure_ascii=False))
            self.assertNotEqual(server.JOBS['rev-bytes-1']['fingerprint'].encode(), first)
            status, rejected = self.post('/api/red/jobs', changed)
            self.assertEqual(status, 400, rejected)
            got, again = self.call('/api/red/jobs/rev-bytes-1')
            self.assertEqual(again['requestBytesDigest'], hashlib.sha256(first).hexdigest())
            self.assertEqual(again['sourceHash'], source)
            self.assertEqual(again['harnessHash'], job['harnessHash'])


if __name__ == '__main__':
    unittest.main()
