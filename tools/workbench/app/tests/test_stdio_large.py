"""Regression tests for slow readers of large stdio requests."""
import hashlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import harness_adapter


class LargeStdinTests(unittest.TestCase):
    def run_child(self, program, data):
        with tempfile.TemporaryDirectory() as cwd:
            return harness_adapter.run_stdio(
                [sys.executable, '-c', program], data, cwd, os.path.join(cwd, 'stdout'))

    def test_delayed_reader_receives_all_bytes_and_eof(self):
        data = ('한글🙂\n' * 100000).encode('utf-8')
        program = (
            'import hashlib,sys,time; time.sleep(.4); '
            'data=sys.stdin.buffer.read(); '
            'sys.stdout.write(str(len(data))+" "+hashlib.sha256(data).hexdigest())'
        )
        result = self.run_child(program, data).decode('ascii')
        self.assertEqual(result, f'{len(data)} {hashlib.sha256(data).hexdigest()}')

    def test_delayed_reader_timeout(self):
        with mock.patch.object(harness_adapter, 'TIMEOUT_SECONDS', .3):
            start = time.monotonic()
            with self.assertRaises(ValueError):
                self.run_child('import time; time.sleep(5)', b'x' * 1000000)
            self.assertLess(time.monotonic() - start, 4)

    def test_output_limit_while_child_is_running(self):
        program = 'import sys,time; sys.stdout.buffer.write(b"x"*2000); sys.stdout.flush(); time.sleep(5)'
        with mock.patch.object(harness_adapter, 'MAX_OUTPUT_BYTES', 1000):
            start = time.monotonic()
            with self.assertRaises(ValueError):
                self.run_child(program, b'x' * 1000000)
            self.assertLess(time.monotonic() - start, 4)


if __name__ == '__main__':
    unittest.main()
