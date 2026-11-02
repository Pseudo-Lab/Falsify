"""Tests for layout_agent_jobs.LayoutStepLedger. No model call: decide is always a local fake."""
from pathlib import Path
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layout_agent_service as service
import layout_agent_jobs as jobs


def inner(**extra):
    return {'schema': service.REQUEST_SCHEMA, 'consent': True, 'projectId': 'a' * 64,
            'step': 0, 'maxSteps': 12, 'instruction': 'Improve layout', 'tools': list(service.TOOLS),
            'observations': [], 'images': [], 'sourceFiles': [{'path': 'main.tex', 'text': 'hello'}], **extra}


def envelope(step_id='s1', run_id='r1', **extra):
    return {'runId': run_id, 'stepId': step_id, 'request': inner(**extra)}


def response(request):
    data = request['data']
    return {'schema': service.RESPONSE_SCHEMA, 'projectId': data['projectId'], 'step': data['step'],
            'action': {'tool': 'finish', 'path': '', 'before': '', 'after': '', 'pages': [], 'message': 'done'},
            'model': request['model'], 'skillHash': 'b' * 64}


class Gate:
    """Admission semaphore and counters standing in for the server's ACTIVE slot."""
    def __init__(self, free=True):
        self.sem = threading.BoundedSemaphore(1)
        if not free: self.sem.acquire()
        self.admits = self.releases = 0
        self.lock = threading.Lock()
    def admit(self):
        with self.lock: self.admits += 1
        return self.sem.acquire(blocking=False)
    def release(self):
        with self.lock: self.releases += 1
        self.sem.release()
    def held(self):
        if self.sem.acquire(blocking=False): self.sem.release(); return False
        return True


class BlockingDecide:
    def __init__(self, outcome=response):
        self.calls, self.started, self.go = 0, threading.Event(), threading.Event()
        self.outcome, self.lock = outcome, threading.Lock()
    def __call__(self, request):
        with self.lock: self.calls += 1
        self.started.set()
        self.go.wait(5)
        return self.outcome(request)


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


def wait_finished(ledger, step_id='s1'):
    for _ in range(500):
        receipt = ledger.get(step_id)
        if receipt['state'] != 'running': return receipt
        threading.Event().wait(0.01)
    raise AssertionError('step did not finish')


class LedgerTests(unittest.TestCase):
    def test_concurrent_identical_submits_decide_once(self):
        decide, gate = BlockingDecide(), Gate()
        ledger = jobs.LayoutStepLedger(decide)
        receipts, barrier = [], threading.Barrier(8)
        def go():
            barrier.wait()
            receipts.append(ledger.submit(envelope(), admit=gate.admit, release=gate.release))
        threads = [threading.Thread(target=go) for _ in range(8)]
        for t in threads: t.start()
        for t in threads: t.join(5)
        self.assertEqual(len(receipts), 8)
        self.assertEqual({r['fingerprint'] for r in receipts}, {jobs.request_fingerprint(inner())})
        self.assertTrue(all(r['state'] == 'running' for r in receipts))
        self.assertEqual(gate.admits, 1)
        decide.go.set()
        receipt = wait_finished(ledger)
        self.assertEqual(decide.calls, 1)
        self.assertEqual(gate.releases, 1)
        self.assertEqual(ledger.submit(envelope(), admit=gate.admit, release=gate.release), receipt)
        self.assertEqual((gate.admits, decide.calls), (1, 1))

    def test_changed_bytes_or_run_conflict_without_second_decide(self):
        decide, gate = BlockingDecide(), Gate()
        ledger = jobs.LayoutStepLedger(decide)
        ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        for changed in (envelope(instruction='Other'), envelope(run_id='r2')):
            with self.assertRaises(service.LayoutAgentError) as caught:
                ledger.submit(changed, admit=gate.admit, release=gate.release)
            self.assertEqual((caught.exception.code, caught.exception.status), ('layout_step_conflict', 409))
        decide.go.set(); wait_finished(ledger)
        with self.assertRaises(service.LayoutAgentError) as caught:
            ledger.submit(envelope(instruction='Other'), admit=gate.admit, release=gate.release)
        self.assertEqual(caught.exception.code, 'layout_step_conflict')
        self.assertEqual((decide.calls, gate.admits, gate.releases), (1, 1, 1))

    def test_validation_precedes_admission(self):
        gate, ledger = Gate(), jobs.LayoutStepLedger(lambda r: self.fail('decide called'))
        good = envelope()
        bad = [None, {}, {**good, 'extra': 1}, {**good, 'runId': ''}, {**good, 'stepId': '../x'},
               {**good, 'stepId': 'a' * 129}, {**good, 'runId': 'r\ud800'}, {**good, 'fingerprint': 'A' * 64},
               {**good, 'request': {**inner(), 'consent': False}},
               {**good, 'request': {**inner(), 'instruction': '\ud800'}},
               {**good, 'request': {**inner(), 'step': 12}},
               {**good, 'request': {**inner(), 'projectId': 'x'}}]
        for data in bad:
            with self.assertRaises(service.LayoutAgentError) as caught:
                ledger.submit(data, admit=gate.admit, release=gate.release)
            self.assertEqual(caught.exception.status, 400)
        with self.assertRaises(service.LayoutAgentError) as caught:
            ledger.submit({**good, 'request': {**inner(), 'instruction': 'x' * 8001}}, admit=gate.admit)
        self.assertEqual(caught.exception.code, 'request_limit')
        with self.assertRaises(service.LayoutAgentError) as caught:
            ledger.submit({**good, 'fingerprint': '0' * 64}, admit=gate.admit)
        self.assertEqual(caught.exception.code, 'fingerprint_mismatch')
        self.assertEqual(gate.admits, 0)
        with self.assertRaises(service.LayoutAgentError): ledger.get('s1')

    def test_supplied_matching_fingerprint_accepted(self):
        gate = Gate()
        ledger = jobs.LayoutStepLedger(response)
        fp = jobs.request_fingerprint(inner())
        self.assertEqual(fp, __import__('hashlib').sha256(jobs.canonical_request_bytes(inner())).hexdigest())
        receipt = ledger.submit({**envelope(), 'fingerprint': fp}, admit=gate.admit, release=gate.release)
        self.assertEqual(receipt['fingerprint'], fp)
        # Same request without the optional fingerprint is the same step.
        wait_finished(ledger)
        self.assertEqual(ledger.submit(envelope(), admit=gate.admit, release=gate.release)['state'], 'completed')
        self.assertEqual(gate.admits, 1)

    def test_busy_admission_refused_and_not_recorded(self):
        gate, decide = Gate(free=False), BlockingDecide()
        ledger = jobs.LayoutStepLedger(decide)
        with self.assertRaises(service.LayoutAgentError) as caught:
            ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        self.assertEqual((caught.exception.code, caught.exception.status), ('companion_busy', 409))
        self.assertEqual(caught.exception.payload()['error'], 'companion_busy')
        self.assertEqual((decide.calls, gate.releases), (0, 0))
        with self.assertRaises(service.LayoutAgentError) as caught: ledger.get('s1')
        self.assertEqual((caught.exception.code, caught.exception.status), ('layout_step_not_found', 404))
        gate.sem.release()
        self.assertEqual(ledger.submit(envelope(), admit=gate.admit, release=gate.release)['state'], 'running')
        decide.go.set(); wait_finished(ledger)
        self.assertEqual((decide.calls, gate.releases), (1, 1))

    def test_success_result_identity(self):
        gate = Gate()
        ledger = jobs.LayoutStepLedger(response)
        data = envelope(step_id='step-7', run_id='run.A', step=3)
        first = ledger.submit(data, admit=gate.admit, release=gate.release)
        self.assertEqual((first['schema'], first['runId'], first['stepId'], first['projectId'], first['step']),
                         (jobs.RECEIPT_SCHEMA, 'run.A', 'step-7', 'a' * 64, 3))
        receipt = wait_finished(ledger, 'step-7')
        self.assertEqual(receipt['state'], 'completed')
        self.assertEqual(receipt['result'], response(service.validate_request(data['request'])))
        self.assertNotIn('error', receipt)
        self.assertEqual(ledger.get('step-7', run_id='run.A'), receipt)
        with self.assertRaises(service.LayoutAgentError): ledger.get('step-7', run_id='run.B')
        receipt['result']['action']['tool'] = 'mutated'
        self.assertEqual(ledger.get('step-7')['result']['action']['tool'], 'finish')
        self.assertEqual(gate.releases, 1)

    def test_failure_sanitized(self):
        secret = 'sk-SECRET token=abc stdout: raw CLI output'
        cases = [(service.LayoutAgentError('cli_login_required'), 'cli_login_required'),
                 (RuntimeError(secret), 'model_failed')]
        for index, (error, code) in enumerate(cases):
            gate = Gate()
            def decide(request, error=error): raise error
            ledger = jobs.LayoutStepLedger(decide)
            ledger.submit(envelope(step_id=f's{index}'), admit=gate.admit, release=gate.release)
            receipt = wait_finished(ledger, f's{index}')
            self.assertEqual((receipt['state'], receipt['error']['error']), ('failed', code))
            self.assertEqual(set(receipt['error']), {'error', 'message'})
            self.assertNotIn('SECRET', repr(receipt))
            self.assertNotIn('result', receipt)
            self.assertEqual(gate.releases, 1)
        # A response for a different project/step or schema is not retained as a result.
        gate = Gate()
        ledger = jobs.LayoutStepLedger(lambda r: {**response(r), 'step': 5, 'raw': secret})
        ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        receipt = wait_finished(ledger)
        self.assertEqual((receipt['state'], receipt['error']['error']), ('failed', 'invalid_action'))
        self.assertNotIn('SECRET', repr(receipt))

    def test_retention_only_for_finished(self):
        clock, decide, gate = Clock(), BlockingDecide(), Gate()
        ledger = jobs.LayoutStepLedger(decide, retention_seconds=3600, now=clock)
        ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        clock.t += 10 * 3600
        self.assertEqual(ledger.get('s1')['state'], 'running')
        decide.go.set(); wait_finished(ledger)
        clock.t += 3600
        self.assertEqual(ledger.get('s1')['state'], 'completed')
        clock.t += 1
        with self.assertRaises(service.LayoutAgentError) as caught: ledger.get('s1')
        self.assertEqual(caught.exception.code, 'layout_step_not_found')
        with self.assertRaises(service.LayoutAgentError): ledger.cancel('s1')

    def test_cancel_keeps_admission_until_callback_returns(self):
        decide, gate = BlockingDecide(), Gate()
        ledger = jobs.LayoutStepLedger(decide)
        ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        self.assertTrue(decide.started.wait(5))
        receipt = ledger.cancel('s1')
        self.assertEqual((receipt['state'], receipt['cancelRequested']), ('running', True))
        self.assertTrue(gate.held())
        self.assertEqual(gate.releases, 0)
        self.assertEqual(ledger.running(), 1)
        decide.go.set()
        receipt = wait_finished(ledger)
        self.assertEqual((receipt['state'], receipt['cancelRequested']), ('cancelled', True))
        self.assertNotIn('result', receipt)
        self.assertEqual(gate.releases, 1)
        self.assertFalse(gate.held())
        # Resubmitting the cancelled step returns its receipt; it is never run again.
        self.assertEqual(ledger.submit(envelope(), admit=gate.admit, release=gate.release), receipt)
        self.assertEqual((decide.calls, gate.admits), (1, 1))

    def test_cancel_completed_drops_result_and_unknown_not_found(self):
        gate = Gate()
        ledger = jobs.LayoutStepLedger(response)
        ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        wait_finished(ledger)
        receipt = ledger.cancel('s1')
        self.assertEqual(receipt['state'], 'cancelled')
        self.assertNotIn('result', receipt)
        for args in (('missing',), ('../etc',), (None,)):
            with self.assertRaises(service.LayoutAgentError) as caught: ledger.cancel(*args)
            self.assertEqual(caught.exception.payload()['error'], 'layout_step_not_found')
        with self.assertRaises(service.LayoutAgentError): ledger.cancel('s1', run_id='other')

    def test_thread_start_failure_releases_once(self):
        class BrokenExecutor:
            def submit(self, *args): raise RuntimeError('cannot start thread')
        gate, calls = Gate(), []
        ledger = jobs.LayoutStepLedger(lambda r: calls.append(r), executor=BrokenExecutor())
        receipt = ledger.submit(envelope(), admit=gate.admit, release=gate.release)
        self.assertEqual((receipt['state'], receipt['error']['error']), ('failed', 'job_start_failed'))
        self.assertEqual((gate.admits, gate.releases, calls), (1, 1, []))
        self.assertFalse(gate.held())
        self.assertEqual(ledger.submit(envelope(), admit=gate.admit, release=gate.release), receipt)
        self.assertEqual((gate.admits, gate.releases), (1, 1))

    def test_admit_exception_propagates_without_record(self):
        def admit(): raise RuntimeError('server closing')
        ledger = jobs.LayoutStepLedger(response)
        with self.assertRaises(RuntimeError): ledger.submit(envelope(), admit=admit)
        with self.assertRaises(service.LayoutAgentError): ledger.get('s1')


if __name__ == '__main__':
    unittest.main()
