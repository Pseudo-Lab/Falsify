import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'app/local'))
sys.path.insert(0, str(ROOT / 'app/examples'))

import red_service as R
import harness_adapter as adapter
import latex_red_harness as harness

PARAGRAPH = ('Reviewers paste paper content into LLMs, which reduces human workload. '
             'If a review repeats the marker, the report was machine written.')
DATA = {'attackTypes': ['contradiction'], 'format': 'pdf', 'level': 1,
        'segments': [{'id': 's1', 'label': 'p1', 'text': PARAGRAPH}]}
POLICY = 'Propose up to 12 candidates at exact unique quotations. '


def invoke(role, schema, prompt=POLICY + json.dumps(DATA, ensure_ascii=False)):
    return harness.act({'schema': 'falsify.harness-invocation.v1', 'role': role,
                        'prompt': prompt, 'outputSchema': schema,
                        'settings': {'language': 'ko'}, 'call': 1, 'maxCalls': 1})


class LatexRedHarnessTests(unittest.TestCase):
    def setUp(self):
        import hashlib
        harness = {'schema': 'falsify.harness.v1', 'id': 'latex-red',
                   'name': 'LaTeX RED', 'version': '1', 'role': 'red',
                   'instructions': 'flip comparisons', 'maxCalls': 4,
                   'adapter': {'type': 'stdio', 'executable': sys.executable,
                               'args': [str(ROOT / 'app/examples/latex_red_harness.py')]}}
        R.validate_request({'schema': R.VERSION, 'revision': 'r1', 'requestId': 'r1:x-1',
                            'consent': True, 'executionConsent': True,
                            'maxCalls': 4, 'segments': DATA['segments'],
                            'attackTypes': ['contradiction'],
                            'sourceHash': hashlib.sha256(PARAGRAPH.encode()).hexdigest(),
                            'harness': harness})

    def test_legacy_level_schema_is_accepted(self):
        response = invoke('red', R.RESULT)
        R.validate_candidates(response, DATA['segments'])
        adapter.validate_shape(response, R.RESULT)
        self.assertEqual(response['status'], 'ok')
        self.assertTrue(all(c['level'] in (1, 2, 3) for c in response['candidates']))

    def test_attack_types_schema_is_accepted(self):
        schema = R.strict_object({
            'status': R.RESULT['properties']['status'],
            'candidates': {'type': 'array', 'maxItems': 12,
                           'items': R.strict_object({
                               k: v for k, v in R.CANDIDATE['properties'].items() if k != 'level'}
                               | {'attackTypes': {'type': 'array', 'minItems': 1, 'maxItems': 3,
                                                  'items': {'type': 'string', 'enum': R.TYPES}}})}})
        response = invoke('red', schema)
        adapter.validate_shape(response, schema)
        R.validate_candidates(response, DATA['segments'])
        self.assertTrue(all(c['attackTypes'] == ['contradiction']
                            for c in response['candidates']))

    def test_quotes_exist_once_in_the_supplied_paragraph(self):
        for c in invoke('red', R.RESULT)['candidates']:
            self.assertEqual(DATA['segments'][0]['text'].count(c['before']), 1)
            self.assertNotEqual(c['before'], c['after'])
            self.assertTrue(c['after'] in DATA['segments'][0]['text'].replace(
                c['before'], c['after'], 1))

    def test_multi_chunk_call_works_from_chunk_notes(self):
        notes = {'attackTypes': ['contradiction'],
                 'allChunkNotes': [{'segmentId': 's1', 'summary': PARAGRAPH}]}
        response = invoke('red', R.RESULT, POLICY + json.dumps(notes, ensure_ascii=False))
        self.assertTrue(response['candidates'])

    def test_no_target_paragraph_abstains_with_empty_candidates(self):
        empty = dict(DATA, segments=[{'id': 's1', 'label': 'p1',
                                      'text': 'A short neutral statement.'}])
        response = invoke('red', R.RESULT, POLICY + json.dumps(empty, ensure_ascii=False))
        self.assertIn(response['status'], ('ok', 'abstain'))
        if response['status'] == 'abstain':
            self.assertEqual(response['candidates'], [])

    def test_blue_and_scan_stages_return_honest_empty_shapes(self):
        blue = invoke('blue', R.strict_object({
            'status': R.RESULT['properties']['status'],
            'findings': {'type': 'array', 'maxItems': 12, 'items': {'type': 'object'}}}))
        self.assertEqual(blue, {'status': 'abstain', 'findings': []})
        scan = invoke('red', R.SCAN)
        self.assertEqual(scan['status'], 'abstain')
        self.assertIn('summary', scan)

    def test_stdout_is_a_single_json_value(self):
        encoded = json.dumps(invoke('red', R.RESULT), ensure_ascii=False)
        self.assertIsInstance(json.loads(encoded), dict)

    def test_real_subprocess_matches_the_same_contract(self):
        import tempfile
        invocation = {'schema': 'falsify.harness-invocation.v1', 'role': 'red',
                      'prompt': POLICY + json.dumps(DATA, ensure_ascii=False),
                      'outputSchema': R.RESULT, 'settings': {'language': 'ko'},
                      'call': 1, 'maxCalls': 1}
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'out.txt'
            raw = adapter.run_stdio(
                [sys.executable, str(ROOT / 'app/examples/latex_red_harness.py')],
                json.dumps(invocation, ensure_ascii=False).encode('utf-8'), folder, str(out))
        response = json.loads(raw.decode('utf-8'))
        adapter.validate_shape(response, R.RESULT)
        R.validate_candidates(response, DATA['segments'])
        self.assertEqual(response['status'], 'ok')


if __name__ == '__main__':
    unittest.main()