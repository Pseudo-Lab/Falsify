"""Integration gates for the synthetic corpus against source plans and independent PDF QA.

Rendering/contract checks only; not scientific gold or RED/BLUE performance. Numeric
fixtures exercise the validator, not authorization to export numeric research attacks.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import paper_inventory
import pdf_foundation_corpus as corpus
import pdf_quality


class FoundationAcceptance(unittest.TestCase):
    def test_corpus_has_no_benign_false_failures_or_defect_false_passes(self):
        # The original capability flags describe the OLD baseline. These cases now
        # gate this foundation's honesty, including unsupported cases remaining warnings.
        for case in corpus.build_corpus():
            with self.subTest(case=case['id']):
                edits = [dict(e, id='edit-' + str(i + 1)) for i, e in enumerate(case['edits'])]
                plan = paper_inventory.build_edit_plan(case['source'], edits) if edits else None
                if case['expected']['planStatus'] == 'ambiguous':
                    self.assertTrue(all(e['status'] != 'resolved' for e in plan['edits']))
                report = pdf_quality.verify_pdf_quality(case['source'], case['output'], case['edits'],
                    case['pageMap'], case['pageCount'], edit_plan=plan)
                self.assertEqual(pdf_quality.sanitize(report), report)
                self.assertNotEqual(report['status'], 'unavailable', 'fixture QA must actually execute')
                if case['expected']['qaGate'] == 'must-not-fail':
                    self.assertNotEqual(report['status'], 'failed', report['checks'])
                else:
                    self.assertNotEqual(report['status'], 'passed', report['checks'])


if __name__ == '__main__':
    unittest.main()
