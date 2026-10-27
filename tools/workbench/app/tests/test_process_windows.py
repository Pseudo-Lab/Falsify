"""Offline subprocess window and transport regression tests."""
import os
import subprocess
import sys
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
        response = SimpleNamespace(returncode=0, stdout='"user","S-1-5-21-1-2-3-1001"\n')
        with patch('subprocess.run', return_value=response) as run:
            pairing._run_icacls(['file', '/Q'])
            self.assertEqual(run.call_args.args[0], ['icacls', 'file', '/Q'])
            self.assertEqual(run.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)
            self.assertEqual(pairing._windows_user_sid(), 'S-1-5-21-1-2-3-1001')
            self.assertEqual(run.call_args.args[0], ['whoami', '/user', '/fo', 'csv', '/nh'])
            self.assertEqual(run.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)


if __name__ == '__main__':
    unittest.main()

