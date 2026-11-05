import hashlib
import threading
import unittest
from unittest.mock import patch
from test_paper_evidence import sample_pdf
from paper_evidence import EvidenceStore
import paper_native_worker


class EvidencePublicationTests(unittest.TestCase):
    def test_slow_extract_does_not_hold_store_lock_and_duplicate_is_atomic(self):
        raw = sample_pdf(pages=1)
        digest = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore()
        entered, release = threading.Event(), threading.Event()
        both_entered = threading.Barrier(3)
        run = paper_native_worker.run
        results, errors = [], []

        def slow(operation, *args, **kwargs):
            self.assertEqual(operation, 'evidence_extract')
            entered.set()
            both_entered.wait(timeout=20)
            if not release.wait(20):
                raise RuntimeError('test timeout')
            return run(operation, *args, **kwargs)

        def prepare():
            try:
                results.append(store.prepare(raw, digest))
            except Exception as exc:
                errors.append(exc)

        with patch.object(paper_native_worker, 'run', side_effect=slow):
            threads = [threading.Thread(target=prepare) for _ in range(2)]
            for thread in threads: thread.start()
            try:
                self.assertTrue(entered.wait(20))
                both_entered.wait(timeout=20)
                self.assertTrue(store._lock.acquire(timeout=1))
                store._lock.release()
            finally:
                release.set()
                for thread in threads: thread.join(60)
        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['paperId'], results[1]['paperId'])
        self.assertEqual(len(store._docs), 1)


if __name__ == '__main__': unittest.main()
