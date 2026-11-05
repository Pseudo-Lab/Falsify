import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'app/local'))
import harness_adapter as adapter
import server


class AdapterFailures(unittest.TestCase):
    def run_process(self, code):
        with tempfile.TemporaryDirectory() as directory:
            return adapter.run_stdio([sys.executable, '-c', code], b'', directory, str(Path(directory) / 'out'))

    def test_process_exit_and_deadline_classification(self):
        for returncode, times, expected in [(3, [0, 0], 'process_exit'),
                                            (124, [0, 0], 'timeout'),
                                            (None, [0, .2, .21], 'timeout')]:
            with self.subTest(returncode=returncode):
                process = Mock(returncode=returncode, pid=12345)
                process.poll.return_value = returncode
                if returncode is None:
                    process.wait.side_effect = [adapter.subprocess.TimeoutExpired('fake', .1), None]

                def launch(argv, **kwargs):
                    kwargs['stdout'].write(b'STDOUT_SECRET')
                    kwargs['stdout'].flush()
                    self.assertIs(kwargs['stderr'], adapter.subprocess.DEVNULL)
                    return process

                termination = (patch.object(adapter.subprocess, 'run') if os.name == 'nt'
                               else patch.object(adapter.os, 'killpg'))
                with patch.object(adapter, 'TIMEOUT_SECONDS', .2), \
                     patch.object(adapter.time, 'monotonic', side_effect=times), \
                     patch.object(adapter.subprocess, 'Popen', side_effect=launch), termination:
                    with self.assertRaises(adapter.AdapterFailure) as caught:
                        self.run_process('unused')
                self.assertEqual(caught.exception.code, expected)
                self.assertNotIn('STDOUT_SECRET', str(caught.exception))
                self.assertNotIn('STDERR_SECRET', str(caught.exception))
                process.wait.assert_any_call(timeout=.1)

    def test_real_process_exit_redacts_output(self):
        code = ('import sys; data = sys.stdin.buffer.read(); '
                'print("STDOUT_SECRET"); sys.stderr.write("STDERR_SECRET"); '
                'sys.exit(3 if data == b"INPUT_MARKER" and sys.argv[1] == "ARG_MARKER" else 0)')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(adapter.AdapterFailure) as caught:
                adapter.run_stdio([sys.executable, '-c', code, 'ARG_MARKER'], b'INPUT_MARKER',
                                  directory, str(Path(directory) / 'out'))
            self.assertEqual(caught.exception.code, 'process_exit')
            self.assertEqual(Path(directory, 'out').read_bytes().strip(), b'STDOUT_SECRET')
            self.assertNotIn('STDOUT_SECRET', str(caught.exception))
            self.assertNotIn('STDERR_SECRET', str(caught.exception))

    def test_real_timeout_and_missing_executable(self):
        with patch.object(adapter, 'TIMEOUT_SECONDS', .2):
            with self.assertRaises(adapter.AdapterFailure) as caught:
                self.run_process('import time; time.sleep(2)')
            self.assertEqual(caught.exception.code, 'timeout')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(adapter.AdapterFailure) as caught:
                adapter.run_stdio([str(Path(directory) / 'missing')], b'', directory, str(Path(directory) / 'out'))
            self.assertEqual(caught.exception.code, 'executable_missing')

    def test_invalid_output_and_one_call(self):
        h = {'role': 'red', 'adapter': {'type': 'stdio', 'executable': sys.executable,
             'args': ['-c', 'print("SECRET")']}}
        backend = adapter.AdapterBackend(h, 1)
        with self.assertRaises(adapter.AdapterFailure) as caught:
            backend.infer('test', {'type': 'object', 'properties': {}})
        self.assertEqual(caught.exception.code, 'invalid_output')
        self.assertEqual(backend.calls, 1)
        self.assertNotIn('SECRET', str(caught.exception))

    def test_first_party_source_binding_without_model(self):
        runner = ROOT / 'app/examples/evidence_blue_v035/runner.py'
        source = ROOT / 'experiments/selfplay_codex.py'
        h = {'adapter': {'type': 'stdio', 'args': [str(runner)]}, 'settings': {
            'diagnosticVersion': '0.3.5', 'auditSchema': 'falsify.blue-evidence-audit.v0.3.5',
            'inheritedSources': {'experiments/selfplay_codex.py': hashlib.sha256(source.read_bytes()).hexdigest()}}}
        adapter.check_first_party_settings(h)
        # The real profile builder computes current source hashes without a model call.
        sys.path.insert(0, str(runner.parent))
        try:
            import build_profile
            with tempfile.TemporaryDirectory() as directory:
                fresh = build_profile.build(Path(directory) / 'profile.json')
            adapter.check_first_party_settings(fresh)
        finally:
            sys.path.pop(0)
        h['settings']['inheritedSources']['experiments/selfplay_codex.py'] = '0' * 64
        with self.assertRaises(adapter.AdapterFailure) as caught: adapter.check_first_party_settings(h)
        self.assertEqual(caught.exception.code, 'settings_mismatch')
        h['adapter']['args'] = ['other.py']
        adapter.check_first_party_settings(h)

    def test_job_contract_and_cli_allowlist(self):
        cases = [(adapter.AdapterFailure(code), code) for code in adapter.FAILURES]
        cases += [(ValueError('CLI BLUE 중단: subscription_login_required'), 'auth_required'),
                  (ValueError('CLI 검토 중단: SECRET'), 'unknown')]
        for error, code in cases:
            job = {'role': 'red', 'cancel': threading.Event(), 'requestBytesDigest': 'original', 'harnessHash': 'hash'}
            with self.subTest(code=code), patch.object(server, 'run_review', side_effect=error):
                self.assertTrue(server.ACTIVE.acquire(blocking=False))
                server.work(job, {})
                public = server.public_job(job)
                self.assertEqual(public['failure'], adapter.AdapterFailure(code).payload())
                self.assertEqual(public['requestBytesDigest'], 'original')
                self.assertEqual(public['harnessHash'], 'hash')
                self.assertNotIn('SECRET', json.dumps(public))

    def test_windows_process_flags_are_unchanged(self):
        if os.name != 'nt': self.skipTest('Windows-specific flag')
        original = adapter.subprocess.Popen
        with patch.object(adapter.subprocess, 'Popen', wraps=original) as popen:
            self.run_process('print("{}")')
            self.assertEqual(popen.call_args.kwargs['creationflags'], adapter.subprocess.CREATE_NO_WINDOW)

if __name__ == '__main__': unittest.main()
