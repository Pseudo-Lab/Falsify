import io
import json
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import server
import harness_adapter
import red_service
import blue_service
from test_document_red import request as red_request
from test_document_blue import BlueTests


class BackendBoundaryTests(unittest.TestCase):
    def test_start_failure_rolls_back_and_next_request_is_accepted(self):
        data = {'requestId': 'start-failure'}
        raw = json.dumps(data).encode()
        replies = []
        handler = SimpleNamespace(path='/api/red/jobs', headers={'Content-Type':'application/json', 'Content-Length':str(len(raw))},
                                  rfile=io.BytesIO(raw), server=SimpleNamespace(instance_id='test'),
                                  authorized=lambda:True, server_closing=lambda:False,
                                  reply=lambda status, body: replies.append((status,body)))
        with patch.object(server,'validate_request'), patch.object(server,'job_binding',return_value={}), \
             patch.object(server.threading.Thread,'start',side_effect=RuntimeError('start')):
            server.Handler.do_POST(handler)
        self.assertEqual(replies[-1][0],500)
        self.assertNotIn(data['requestId'],server.JOBS)
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        server.ACTIVE.release()
        handler.rfile=io.BytesIO(raw)
        with patch.object(server,'validate_request'), patch.object(server,'job_binding',return_value={}), \
             patch.object(server.threading.Thread,'start'):
            server.Handler.do_POST(handler)
        self.assertEqual(replies[-1][0],202)
        server.JOBS.pop(data['requestId'])
        server.ACTIVE.release()
        with self.assertRaises(ValueError): server.ACTIVE.release()

    def test_job_construction_failure_releases_admission(self):
        handler = SimpleNamespace(server_closing=lambda: False, reply=lambda *args: None)
        with patch.object(server.threading, 'Event', side_effect=RuntimeError('event')):
            with self.assertRaisesRegex(RuntimeError, 'event'):
                server.Handler._start_registered_job(handler, {}, 'red', {}, 'fingerprint', 'construction-failure', None)
        self.assertNotIn('construction-failure', server.JOBS)
        self.assertTrue(server.ACTIVE.acquire(blocking=False))
        server.ACTIVE.release()

    def test_provider_errors_are_typed_in_both_independent_routes(self):
        for role, request, service in [('red',red_request(),red_service),('blue',BlueTests().request(),blue_service)]:
            for source, expected in [('chatgpt_login_required','auth_required'),('subscription_login_required','auth_required'),
                                     ('timeout','timeout'),('protocol_violation','invalid_output')]:
                with self.subTest(role=role,source=source):
                    class FailureBackend:
                        def __init__(self, *args, **kwargs): pass
                        def infer(self, *args): return {'status':'error','error_code':source}
                    with self.assertRaises(harness_adapter.AdapterFailure) as caught:
                        service.run_review(request,lambda _:None,threading.Event(),FailureBackend)
                    self.assertEqual(caught.exception.code,expected)
                    self.assertEqual(caught.exception.payload()['recovery'],harness_adapter.FAILURES[expected][1])

if __name__ == '__main__': unittest.main()
