"""No model/network: actual adapter audit path and source-binding contract."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runner
from red_service import SCAN, evidence_check

TEXT = 'The measured value was 0.80 and was not final across range.'


class IntegrationTests(unittest.TestCase):
    def execute(self, quote, delivered=TEXT, schema=SCAN, response=None):
        raw = response or {'status': 'ok', 'summary': 'Original summary', 'evidence': [
            {'segmentId': 's1', 'quote': quote, 'relation': 'Original relation'}]}
        before = copy.deepcopy(raw)
        invocation = {'schema': 'falsify.harness-invocation.v1', 'role': 'blue', 'call': 1, 'maxCalls': 4,
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': [{'id': 's1', 'text': delivered}]}),
            'outputSchema': schema, 'settings': {'bundleSha256': runner.bundle_identity(),
            'scope': runner.SCOPE, 'internalMaxCalls': 4,
            'externalLookup': {'enabled': True, 'providers': ['crossref', 'europepmc']}}}
        def fixture(stage, prompt, out_schema, remaining):
            self.assertEqual(stage, 'document-stage')
            if 'summary' in schema.get('properties', {}):
                self.assertEqual(out_schema['properties']['summary']['maxLength'], 2500)
                self.assertEqual(out_schema['properties']['evidence']['items']['properties']['quote']['maxLength'], 600)
            return {'status': 'ok', 'response': raw, 'observed_tool_calls': 0}
        def no_network(*args):
            self.fail('Network must not occur in scan fixtures')
        answer, failure = None, None
        with tempfile.TemporaryDirectory() as folder:
            try:
                answer = runner.execute(json.dumps(invocation).encode(), fixture, no_network, folder)
            except runner.AuditFailure as error:
                failure = error.code
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))
        self.assertEqual(raw, before)
        self.assertEqual(audit['modelCalls'][0]['response'], before)
        self.assertEqual(len(audit['modelCalls']), 1)
        self.assertEqual(audit['diagnosticVersion'], '0.3.3')
        return answer, audit, failure

    def test_scan_reanchors_then_passes_original_validator(self):
        answer, audit, failure = self.execute(TEXT.replace('value was', 'value\nwas'))
        self.assertIsNone(failure)
        self.assertEqual(answer['evidence'][0]['quote'], TEXT)
        evidence_check(answer['evidence'], {'s1': TEXT}, 600)
        self.assertEqual(audit['scanDerivation']['provenance']['items'][0]['decision'], 'reanchored')
        self.assertNotEqual(audit['scanDerivation']['rawResponseSha256'], audit['scanDerivation']['derivedResponseSha256'])

    def test_changed_number_fails_without_dropping_evidence(self):
        quote = TEXT.replace('0.80', '0.81')
        answer, audit, failure = self.execute(quote)
        self.assertIsNone(answer)
        self.assertEqual(failure, 'scan_reanchor_failed')
        self.assertEqual(len(audit['scanDerivation']['derivedResponse']['evidence']), 1)
        self.assertEqual(audit['scanDerivation']['derivedResponse']['evidence'][0]['quote'], quote)

    def test_undelivered_quote_fails(self):
        _, audit, failure = self.execute(TEXT, delivered='An unrelated part of the paper.')
        self.assertEqual(failure, 'scan_reanchor_failed')
        self.assertEqual(audit['scanDerivation']['provenance']['items'][0]['reason'], 'missing')

    def test_runtime_preserves_line_end_hyphen(self):
        text = 'The symbolic expression x-\ny remained unchanged in all reported calculations.'
        _, audit, failure = self.execute(text.replace('x-\ny', 'xy'), delivered=text)
        self.assertEqual(failure, 'scan_reanchor_failed')
        self.assertTrue(audit['scanDerivation']['blockedByRuntimePolicy'])

    def test_selection_is_not_rewritten(self):
        from blue_service import SELECTION
        response = {'status': 'ok', 'targets': [{'segmentId': 's1', 'anchor': 'Different anchor', 'reason': 'Why'}]}
        answer, audit, failure = self.execute('', schema=SELECTION, response=response)
        self.assertIsNone(failure)
        self.assertEqual(answer, response)
        self.assertNotIn('scanDerivation', audit)

    def test_oversized_summary_is_not_truncated_or_dropped(self):
        response = {'status': 'ok', 'summary': 'x' * 2678, 'evidence': []}
        answer, audit, failure = self.execute('', response=response)
        self.assertIsNone(answer)
        self.assertEqual(failure, 'scan_contract_failed')
        self.assertEqual(len(audit['modelCalls'][0]['response']['summary']), 2678)
        self.assertNotIn('scanDerivation', audit)


if __name__ == '__main__':
    unittest.main()
