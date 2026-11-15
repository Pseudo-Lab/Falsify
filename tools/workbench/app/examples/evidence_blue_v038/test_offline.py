"""Offline tests for BLUE Evidence v0.3.8. Zero pytest and zero live network."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
import build_profile
import runner

EXACT_LINE = 'Primary endpoint was hemoglobin stability.'
LEDGER_QUOTE = 'We enrolled N = 40 patients.'
SCAN_SCHEMA = {
    'type': 'object',
    'additionalProperties': True,
    'required': ['summary', 'targets'],
    'properties': {
        'summary': {'type': 'string'},
        'targets': {'type': 'array'},
    },
}
ID_SELECTION = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['status', 'targets'],
    'properties': {
        'status': {'type': 'string'},
        'targets': {'type': 'array'},
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_network_call')


def _parse_digest_json(prompt):
    marker = runner.DIGEST_HEADER.strip()
    idx = prompt.find(marker)
    assert idx != -1, 'digest header missing'
    return json.loads(prompt[idx + len(marker):].lstrip('\n'))


class OfflineV038Tests(unittest.TestCase):
    def setUp(self):
        self._net_patcher = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net_patcher.start()

    def tearDown(self):
        self._net_patcher.stop()

    def _payload(self, segments, schema=None):
        return json.dumps({
            'schema': 'falsify.harness-invocation.v1',
            'role': 'blue',
            'call': 1,
            'maxCalls': 8,
            'settings': runner.contract_settings(),
            'prompt': runner.MARKER + '. ' + json.dumps({'segments': segments}, ensure_ascii=False),
            'outputSchema': schema or ID_SELECTION,
        }, ensure_ascii=False).encode('utf-8')

    def _run(self, segments, model, schema=None):
        with tempfile.TemporaryDirectory() as folder:
            answer = runner.execute(self._payload(segments, schema), model, no_network, folder)
            audit = json.loads(next(Path(folder).glob('*.json')).read_text(encoding='utf-8'))
        return answer, audit

    def test_profile_contract_and_bundle_isolation(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        self.assertEqual(profile['id'], 'shinick-blue-evidence-triage-v038')
        self.assertEqual(profile['version'], '0.3.8')
        self.assertEqual(profile['settings']['auditSchema'], runner.AUDIT_SCHEMA)
        runner.check_settings(profile['settings'])
        for rel in runner.TRACKED_SOURCES:
            self.assertIn(rel, runner.source_map())
        drifted = dict(profile['settings'], diagnosticVersion='0.3.7')
        with self.assertRaisesRegex(ValueError, 'settings_contract'):
            runner.check_settings(drifted)
        before = runner.bundle_identity()
        previous = runner.v037.bundle_identity()
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name == 'paper_raw_dataset_audit.py':
                return data + b'\n# tamper\n'
            return data

        with patch.object(runner, 'read_bytes', side_effect=tampered):
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v037.bundle_identity(), previous)
        self.assertEqual(runner.bundle_identity(), before)

    def test_raw_dataset_signal_is_injected_into_digest(self):
        segments = [
            {
                'id': 's0',
                'text': 'In the cohort patients we enrolled N = 99. Alpha score was 1.00 ± 0.10.',
            },
            {
                'id': 'supp-0-0',
                'label': '[보충: cohort.csv · Main]',
                'text': 'id,group,score\n1,Alpha,10\n2,Alpha,12\n3,Alpha,11\n4,Beta,30\n5,Beta,32\n6,Beta,31\n',
            },
        ]
        seen = []

        def fake_model(stage, prompt, schema, seconds):
            seen.append((stage, prompt))
            return {'status': 'ok', 'response': {'status': 'abstain', 'targets': []}}

        answer, audit = self._run(segments, fake_model)
        triage = audit['deterministicTriage']
        self.assertEqual(triage['schema'], runner.TRIAGE_SCHEMA)
        self.assertEqual(triage['rawDatasetAudit']['datasetCount'], 1)
        self.assertGreaterEqual(triage['rawDatasetAudit']['signalCount'], 1)
        self.assertEqual(answer['status'], 'abstain')
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])
        digest = _parse_digest_json(seen[0][1])
        self.assertIn('rawDatasetSignals', digest)
        self.assertTrue(any(sig['kind'] == 'raw_dataset_n_mismatch' for sig in digest['rawDatasetSignals']))
        self.assertIn('raw dataset recomputation is unadjusted', seen[0][1])

    def test_zero_drop_restores_missing_ledger_candidate(self):
        segments = [{'id': 's0', 'text': LEDGER_QUOTE + ' Follow-up was complete.'}]
        stages = []

        def fake_model(stage, prompt, schema, seconds):
            stages.append(stage)
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'candidateLedger': [{
                    'candidateId': 'C9',
                    'quote': LEDGER_QUOTE,
                    'defectFamily': 'D6',
                    'pageIndex': 0,
                    'locationLabel': 'Results',
                }],
                'findings': [],
            }}

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        self.assertEqual(stages, ['document-stage'])
        self.assertEqual(len(answer['findings']), 1)
        restored = answer['findings'][0]
        self.assertEqual(restored['verdictLabel'], '확인필요')
        self.assertTrue(restored['zeroDropRecovered'])
        self.assertTrue(audit['reportValidation']['zeroDropRecovered'])
        self.assertEqual(audit['reportValidation']['zeroDrop']['recoveredCount'], 1)
        self.assertFalse(audit['reportValidation']['quoteRepairInvoked'])

    def test_one_quote_repair_keeps_a_grounded_defect(self):
        segments = [{'id': 's0', 'text': EXACT_LINE + '\nOther context stays local.'}]
        stages = []

        def fake_model(stage, prompt, schema, seconds):
            stages.append(stage)
            if stage == 'quote-repair':
                self.assertIn(EXACT_LINE, prompt)
                return {'status': 'ok', 'response': {'findings': [{
                    'id': 'F1',
                    'quote': EXACT_LINE,
                    'verdictLabel': 'defect',
                    'rationale': 'grounded after repair',
                }]}}
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'findings': [{
                    'id': 'F1',
                    'verdictLabel': 'defect',
                    'quote': 'this sentence was never supplied',
                    'rationale': 'hallucinated',
                }],
            }}

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        self.assertEqual(stages, ['document-stage', 'quote-repair'])
        self.assertEqual(answer['findings'][0]['quote'], EXACT_LINE)
        self.assertEqual(answer['findings'][0]['verdictLabel'], 'defect')
        self.assertTrue(audit['reportValidation']['quoteRepairInvoked'])
        self.assertEqual(audit['reportValidation']['downgradedIds'], [])
        self.assertEqual(audit['reportValidation']['quoteChecks'][0]['status'], 'exact')

    def test_hallucinated_quote_is_downgraded_after_one_repair(self):
        segments = [{'id': 's0', 'text': EXACT_LINE}]
        stages = []

        def fake_model(stage, prompt, schema, seconds):
            stages.append(stage)
            if stage == 'quote-repair':
                return {'status': 'ok', 'response': {'findings': [{
                    'id': 'F1',
                    'quote': 'still invented after the repair turn',
                    'verdictLabel': 'defect',
                    'rationale': 'still wrong',
                }]}}
            return {'status': 'ok', 'response': {
                'summary': 'scan',
                'targets': [],
                'findings': [{
                    'id': 'F1',
                    'verdictLabel': 'defect',
                    'quote': 'original hallucination',
                    'rationale': 'bad',
                }],
            }}

        answer, audit = self._run(segments, fake_model, SCAN_SCHEMA)
        self.assertEqual(stages.count('quote-repair'), 1)
        finding = answer['findings'][0]
        self.assertEqual(finding['verdictLabel'], '확인필요')
        self.assertTrue(finding['rationale'].startswith('[인용 미검증 자동 강등] '))
        self.assertEqual(audit['reportValidation']['downgradedIds'], ['F1'])
        self.assertEqual(audit['reportValidation']['quoteChecks'][0]['status'], 'missing')

    def test_runner_functions_stay_within_ccn_limit(self):
        script = REPO / 'tools' / 'quality' / 'python-functions.py'
        for name in ('runner.py', 'build_profile.py', 'test_offline.py'):
            proc = subprocess.run(
                [sys.executable, str(script)],
                input=(HERE / name).read_bytes(),
                capture_output=True,
                check=True,
            )
            fns = json.loads(proc.stdout.decode('utf-8'))
            over = [f"{item['id']}:{item['ccn']}" for item in fns if item['ccn'] > 15]
            self.assertEqual(over, [], name)


if __name__ == '__main__':
    unittest.main()
