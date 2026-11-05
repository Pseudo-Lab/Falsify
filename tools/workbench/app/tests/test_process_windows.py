"""Offline subprocess window and transport regression tests."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'app' / 'local'))
from experiments import selfplay_codex
import pairing


class ProcessWindowTests(unittest.TestCase):
    def test_pairing_native_output_in_utf8_parent(self):
        # Exercise real subprocess pipes, including both output streams, without
        # depending on the host's account name or Windows display language.
        script = r'''
import subprocess, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import pairing
real_run = subprocess.run
failure = False
def fake_command(args, **kwargs):
    if args[0] == 'whoami':
        payload = b'"account-\xc6","S-1-5-21-1-2-3-1001"\r\n'
    else:
        payload = b'localized-\xc6\r\n'
    code = "import sys; sys.stdout.buffer.write(%r); sys.stderr.buffer.write(b'\\xc6'); sys.exit(%d)" % (payload, failure)
    return real_run([sys.executable, '-c', code], **kwargs)
with patch('subprocess.run', side_effect=fake_command):
    pairing._run_icacls(['file', '/Q'])
    assert pairing._windows_user_sid() == 'S-1-5-21-1-2-3-1001'
    failure = True
    for fn in (lambda: pairing._run_icacls(['file']), pairing._windows_user_sid):
        try:
            fn()
        except pairing.PairingError as error:
            assert error.code == 'pairing_store_permissions'
        else:
            raise AssertionError('permission failure accepted')
'''
        env = os.environ.copy()
        env['PYTHONUTF8'] = '1'
        result = subprocess.run([sys.executable, '-c', script, str(ROOT / 'app' / 'local')],
                                capture_output=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        self.assertEqual(result.stderr, b'')

    def test_pairing_native_timeout_reaps_child_and_next_check_works(self):
        real_run = subprocess.run
        real_popen = subprocess.Popen
        children = []

        def sleeping_command(args, **kwargs):
            return real_run([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)

        def track_child(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        for check in (lambda: pairing._run_icacls(['file']), pairing._windows_user_sid):
            with self.subTest(check=check):
                with patch.object(pairing, '_WINDOWS_COMMAND_TIMEOUT_SECONDS', 0.5), \
                     patch('subprocess.run', side_effect=sleeping_command), \
                     patch('subprocess.Popen', side_effect=track_child):
                    with self.assertRaises(pairing.PairingError) as error:
                        check()
                self.assertEqual(error.exception.code, 'pairing_store_permissions')
                self.assertIsNotNone(children[-1].returncode)
                self.assertIsNotNone(children[-1].poll())
                if os.name == 'nt':
                    # An independent real permission operation still succeeds after the timeout.
                    with tempfile.TemporaryDirectory() as tmp:
                        path = Path(tmp) / 'private'
                        path.write_bytes(b'synthetic')
                        pairing._restrict_new(path, False)
                        pairing._assert_private(path, False)

    def test_pairing_rejects_non_ascii_sid(self):
        response = SimpleNamespace(returncode=0, stdout=b'"account","S-1-5-21-\xc6"\r\n')
        with patch('subprocess.run', return_value=response):
            with self.assertRaises(pairing.PairingError) as error:
                pairing._windows_user_sid()
        self.assertEqual(error.exception.code, 'pairing_store_permissions')

    def test_transport_flags_and_streaming(self):
        real_popen = subprocess.Popen
        with patch.object(selfplay_codex.subprocess, 'Popen', wraps=real_popen) as popen:
            result = selfplay_codex.bounded_transport(
                [sys.executable, '-c', 'import sys; print(sys.stdin.read()); print("err", file=sys.stderr)'],
                cwd=str(ROOT), env=os.environ.copy(), stdin='hello', timeout_seconds=10, max_output_bytes=1000)
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(result['stdout'].splitlines(), ['hello'])
        kw = popen.call_args.kwargs
        self.assertFalse(kw['shell'])
        if os.name == 'nt':
            self.assertEqual(kw['creationflags'], subprocess.CREATE_NO_WINDOW)
        else:
            self.assertTrue(kw['start_new_session'])
            self.assertNotIn('creationflags', kw)

    @unittest.skipUnless(os.name == 'nt', 'Windows console behavior')
    def test_real_child_has_no_console_window(self):
        result = selfplay_codex.bounded_transport(
            [sys.executable, '-c', 'import ctypes; print(ctypes.windll.kernel32.GetConsoleWindow())'],
            cwd=str(ROOT), env=os.environ.copy(), stdin='', timeout_seconds=10, max_output_bytes=1000)
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(result['stdout'].splitlines(), ['0'])

    def test_transport_limits_still_stop_children(self):
        for code, timeout, limit, error in [
            ('import time; time.sleep(30)', .3, 1000, TimeoutError),
            ('import sys, time; sys.stdout.write("x" * 8192); sys.stdout.flush(); time.sleep(30)', 10, 100, ValueError),
        ]:
            with self.subTest(error=error), self.assertRaises(error):
                selfplay_codex.bounded_transport(
                    [sys.executable, '-c', code], cwd=str(ROOT), env=os.environ.copy(),
                    stdin='', timeout_seconds=timeout, max_output_bytes=limit)

    @unittest.skipUnless(os.name == 'nt', 'Windows taskkill')
    def test_taskkill_has_no_window_flag(self):
        process = SimpleNamespace(pid=123, poll=lambda: None, kill=lambda: None, wait=lambda **kw: None)
        with patch.object(selfplay_codex.subprocess, 'run') as run:
            selfplay_codex._kill_tree(process)
        self.assertEqual(run.call_args.args[0], ['taskkill', '/PID', '123', '/T', '/F'])
        self.assertEqual(run.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)

    @unittest.skipUnless(os.name == 'nt', 'Windows ACL commands')
    def test_pairing_commands_have_no_window_flag(self):
        response = SimpleNamespace(returncode=0, stdout=b'"user","S-1-5-21-1-2-3-1001"\n')
        with patch('subprocess.run', return_value=response) as run:
            pairing._run_icacls(['file', '/Q'])
            self.assertEqual(run.call_args.args[0], ['icacls', 'file', '/Q'])
            self.assertEqual(run.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)
            self.assertEqual(pairing._windows_user_sid(), 'S-1-5-21-1-2-3-1001')
            self.assertEqual(run.call_args.args[0], ['whoami', '/user', '/fo', 'csv', '/nh'])
            self.assertEqual(run.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)


if __name__ == '__main__':
    unittest.main()

