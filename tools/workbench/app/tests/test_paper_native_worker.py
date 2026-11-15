import hashlib
import json
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_native_worker as native

class NativeWorkerTests(unittest.TestCase):
    def source(self):
        doc = pymupdf.open(); doc.new_page(); raw = doc.tobytes(); doc.close()
        return raw

    def test_hang_crash_cancel_and_next_operation(self):
        original = subprocess.Popen
        def launch(code):
            def start(*args, **kwargs):
                if args and isinstance(args[0], list) and '--worker' in args[0]:
                    return original([sys.executable, '-c', code], **kwargs)
                return original(*args, **kwargs)
            return start
        with patch.object(native.subprocess, 'Popen', side_effect=launch('import time; time.sleep(30)')):
            with self.assertRaisesRegex(ValueError, 'native_timeout'): native.run('verify', [], timeout=.3)
        with patch.object(native.subprocess, 'Popen', side_effect=launch('raise SystemExit(3)')):
            with self.assertRaisesRegex(ValueError, 'native_worker_failed'): native.run('verify', [])
        cancelled = threading.Event()
        timer = threading.Timer(.3, cancelled.set)
        with patch.object(native.subprocess, 'Popen', side_effect=launch('import time; time.sleep(30)')):
            timer.start()
            try:
                with self.assertRaisesRegex(ValueError, 'native_cancelled'): native.run('verify', [], cancelled=cancelled)
            finally: timer.cancel()

        raw = self.source(); digest = hashlib.sha256(raw).hexdigest()
        record = native.run('evidence_extract', [raw, digest])
        self.assertEqual(record['pdf'], raw)
        self.assertEqual(record['file_hash'], digest)

    def test_byte_envelope_rejects_corruption(self):
        envelope = native._pack(b'content'); envelope['size'] += 1
        with self.assertRaisesRegex(ValueError, 'native_output_invalid'): native._unpack(envelope)

    def test_invalid_and_oversized_replies(self):
        original = subprocess.Popen
        for code in ("print('[]')", "print('x' * 4096)"):
            def launch(*args, **kwargs):
                return original([sys.executable, '-c', code], **kwargs)
            with patch.object(native, 'MAX_RESPONSE', 1024), patch.object(native.subprocess, 'Popen', side_effect=launch):
                with self.assertRaisesRegex(ValueError, 'native_output_invalid'):
                    native.run('verify', [])

    def test_nested_dispatch_is_inline(self):
        with patch.object(native, '_IN_WORKER', True), patch.object(native, '_dispatch', return_value='inline'), patch.object(native.subprocess, 'Popen', side_effect=AssertionError('nested child')):
            self.assertEqual(native.run('verify', []), 'inline')

    def test_fixed_hyphenated_codes_survive_worker_transport(self):
        for code in ('nested-form', 'bad-bbox', 'ambiguous-path', 'native_timeout'):
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, '^'+code+'$'):
                native._worker_response([json.dumps({'ok': False, 'error': code}).encode()])
        with self.assertRaisesRegex(ValueError, '^bad-plot$'):
            native.run('chart_prepare', [self.source(), 0, [0, 0, 10, 10], {'plotBbox': [5, 5, 1, 1]}, None])
        with self.assertRaisesRegex(ValueError, '^native_worker_failed$'):
            native._worker_response([json.dumps({'ok': False, 'error': 'private/path with details'}).encode()])

if __name__ == '__main__': unittest.main()
