"""Real pipe regression: delayed input consumption, cancellation and timeout."""
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_enrichment as enrichment


class TransportTests(unittest.TestCase):
    def run_worker(self, script, *, timeout=5, cancel=None):
        spawn = subprocess.Popen
        children = []

        def worker(_args, **kwargs):
            if '--worker' not in _args:
                return spawn(_args, **kwargs)
            child = spawn([sys.executable, '-I', '-c', script], **kwargs)
            children.append(child)
            return child

        payload = bytes(range(256)) * 8192
        try:
            with patch.object(enrichment.subprocess, 'Popen', side_effect=worker):
                return enrichment.run_child('chart', payload, 'en', cancel or threading.Event(), timeout=timeout)
        finally:
            self.assertEqual(len(children), 1)
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdin.closed)
            self.assertTrue(children[0].stdout.closed)

    def test_delayed_reader_receives_entire_large_input(self):
        result = self.run_worker('''
import base64,json,sys,time
time.sleep(0.6)
request=json.load(sys.stdin)
payload=base64.b64decode(request['png'])
print(json.dumps({'ok':True,'data':{'bytes':len(payload),'tail':list(payload[-4:])}}))
''')
        self.assertEqual(result, {'bytes': 2097152, 'tail': [252, 253, 254, 255]})

    def test_cancel_interrupts_blocked_stdin(self):
        cancel = threading.Event()
        timer = threading.Timer(0.4, cancel.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(ValueError, '^analysis_cancelled$'):
                self.run_worker('import time; time.sleep(30)', cancel=cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 5)

    def test_timeout_interrupts_blocked_stdin(self):
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, '^analysis_timeout$'):
            self.run_worker('import time; time.sleep(30)', timeout=0.4)
        self.assertLess(time.monotonic() - started, 5)


if __name__ == '__main__':
    unittest.main()
